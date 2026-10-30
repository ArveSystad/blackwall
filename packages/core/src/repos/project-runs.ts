import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  MAX_PROJECT_OUTPUT_CHARS,
  type ProjectRun,
  type ProjectRunOutput,
  type ProjectRunStatus,
  type ServerEvent,
} from "@blackwall/shared";
import { killTree, spawnTree } from "../agents/adapters/process.js";
import type { Repositories } from "../db/repositories.js";
import { TOKEN_ENV_PREFIX } from "../secrets/tokens.js";
import { InvalidRepoError, RepoBusyError, RepoNotFoundError } from "./service.js";

/**
 * A run counts as `running` once its commands have stayed up this long, in ms:
 * dev servers don't report that they are ready.
 */
export const STARTUP_GRACE_MS = 3_000;

/** The least time between two `projectRun.output` events of a run, in ms. */
export const PROJECT_OUTPUT_THROTTLE_MS = 100;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** An escape sequence cut off at the end of a chunk; held back for the next one. */
// eslint-disable-next-line no-control-regex
const OPEN_ANSI = /\u001b(?:\[[0-9;?]*)?$/;

const ACTIVE: readonly ProjectRunStatus[] = ["starting", "running", "stopping"];

export interface ProjectRunsOptions {
  repos: Pick<Repositories["repos"], "get">;
  publish: (event: ServerEvent) => void;
  /** Spawns one run command; the default is {@link spawnTree}. */
  spawn?: typeof spawnTree;
  /** Kills a command's process tree; the default is {@link killTree}. */
  kill?: (child: ChildProcess) => Promise<void>;
  /** See {@link STARTUP_GRACE_MS}. */
  graceMs?: number;
  /** See {@link PROJECT_OUTPUT_THROTTLE_MS}. */
  throttleMs?: number;
}

export type ProjectRuns = ReturnType<typeof createProjectRuns>;

interface Entry {
  run: ProjectRun;
  children: ChildProcess[];
  /** Commands whose process has not closed yet. */
  open: number;
  /** The first failure; the run ends `failed` with it. */
  failure: string | null;
  /** The output tail; up to twice {@link MAX_PROJECT_OUTPUT_CHARS} before it is cut. */
  output: string;
  end: number;
  /** Output not yet published. */
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Unfinished lines, per command and stream, flushed when the command closes. */
  partials: Map<string, string>;
  done: Promise<void>;
  resolveDone: () => void;
}

/** The server's environment without blackwall's tokens, which must never reach user processes. */
function runEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith(TOKEN_ENV_PREFIX)),
  );
}

/**
 * Run project: each repo's run commands as background processes in the repo's
 * folder, side by side, at most one run per repo. Runs live in memory only;
 * every status change is published as `projectRun.upserted` and the output,
 * batched, as `projectRun.output`. Output is plain text: ANSI codes are
 * stripped, carriage returns become newlines, and with several commands each
 * line is prefixed with `[n] `.
 */
export function createProjectRuns({
  repos,
  publish,
  spawn = spawnTree,
  kill = killTree,
  graceMs = STARTUP_GRACE_MS,
  throttleMs = PROJECT_OUTPUT_THROTTLE_MS,
}: ProjectRunsOptions) {
  const entries = new Map<string, Entry>();

  function publishRun(entry: Entry): void {
    publish({ type: "projectRun.upserted", payload: { run: entry.run } });
  }

  function setStatus(entry: Entry, patch: Partial<ProjectRun>): void {
    entry.run = { ...entry.run, ...patch };
    publishRun(entry);
  }

  function flush(entry: Entry): void {
    if (entry.flushTimer) clearTimeout(entry.flushTimer);
    entry.flushTimer = null;
    if (!entry.pending) return;
    const { repoId, runId } = entry.run;
    publish({
      type: "projectRun.output",
      payload: { repoId, runId, end: entry.end, text: entry.pending },
    });
    entry.pending = "";
  }

  function write(entry: Entry, text: string): void {
    if (!text) return;
    entry.output += text;
    entry.end += text.length;
    // Bound memory for chatty commands; only the tail is kept anyway.
    if (entry.output.length > MAX_PROJECT_OUTPUT_CHARS * 2) {
      entry.output = entry.output.slice(-MAX_PROJECT_OUTPUT_CHARS);
    }
    entry.pending = (entry.pending + text).slice(-MAX_PROJECT_OUTPUT_CHARS);
    entry.flushTimer ??= setTimeout(() => flush(entry), throttleMs);
  }

  /** Writes text on a line of its own. */
  function writeLine(entry: Entry, line: string): void {
    const fresh = entry.output === "" || entry.output.endsWith("\n");
    write(entry, `${fresh ? "" : "\n"}${line}\n`);
  }

  /** Writes a command's normalised output, line by line with its `[n] ` prefix when there are several. */
  function writeFrom(entry: Entry, key: string, index: number, text: string): void {
    if (entry.run.commands.length < 2) {
      write(entry, text);
      return;
    }
    const lines = ((entry.partials.get(key) ?? "") + text).split("\n");
    entry.partials.set(key, lines.pop() ?? "");
    write(entry, lines.map((line) => `[${index + 1}] ${line}\n`).join(""));
  }

  function flushPartials(entry: Entry, index: number): void {
    for (const stream of ["stdout", "stderr"]) {
      const key = `${index}:${stream}`;
      const partial = entry.partials.get(key);
      if (partial) write(entry, `[${index + 1}] ${partial}\n`);
      entry.partials.delete(key);
    }
  }

  /** Decodes and normalises a stream, holding back a `\r` or escape sequence a chunk ends in. */
  function pipe(entry: Entry, child: ChildProcess, index: number, stream: "stdout" | "stderr") {
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const emit = (raw: string, final: boolean) => {
      let text = carry + raw;
      carry = "";
      if (!final) {
        const open = OPEN_ANSI.exec(text) ?? /\r$/.exec(text);
        if (open) {
          carry = text.slice(open.index);
          text = text.slice(0, open.index);
        }
      }
      text = text.replace(ANSI, "").replace(/\r\n?/g, "\n");
      writeFrom(entry, `${index}:${stream}`, index, text);
    };
    child[stream]?.on("data", (chunk: Buffer) => emit(decoder.write(chunk), false));
    child[stream]?.on("end", () => emit(decoder.end(), true));
  }

  function finish(entry: Entry): void {
    if (entry.graceTimer) clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
    const stopped = entry.run.status === "stopping";
    const status: ProjectRunStatus = stopped ? "stopped" : entry.failure ? "failed" : "exited";
    writeLine(
      entry,
      stopped ? "[Stopped]" : entry.failure ? `[Failed: ${entry.failure}]` : "[Exited]",
    );
    flush(entry);
    setStatus(entry, {
      status,
      endedAt: new Date(),
      error: status === "failed" ? entry.failure : null,
    });
    entry.resolveDone();
  }

  function killAll(entry: Entry): Promise<void> {
    return Promise.all(entry.children.map((child) => kill(child))).then(() => undefined);
  }

  /** Marks the run failed (first failure wins) and stops its other commands. */
  function fail(entry: Entry, message: string): void {
    if (entry.run.status === "stopping" || entry.failure) return;
    entry.failure = message;
    void killAll(entry);
  }

  function launch(entry: Entry, cwd: string): void {
    const env = runEnv();
    entry.run.commands.forEach((command, index) => {
      let closed = false;
      const close = (failure: string | null) => {
        if (closed) return;
        closed = true;
        if (entry.run.commands.length > 1) flushPartials(entry, index);
        if (failure) fail(entry, failure);
        entry.open -= 1;
        if (entry.open === 0) finish(entry);
      };
      // An earlier command already failed to start: the run is over.
      if (entry.failure) {
        close(null);
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(command, [], { cwd, shell: true, env });
      } catch (error) {
        close(`Could not start \`${command}\`: ${(error as Error).message}`);
        return;
      }
      entry.children.push(child);
      // stdin stays open and unused: some dev servers exit when it closes.
      pipe(entry, child, index, "stdout");
      pipe(entry, child, index, "stderr");
      child.once("error", (error) => {
        writeLine(entry, error.message);
        close(`Could not start \`${command}\`: ${error.message}`);
      });
      child.once("close", (code, signal) => {
        if (code === 0) close(null);
        else
          close(
            `\`${command}\` ${code === null ? `was killed (${signal})` : `exited with code ${code}`}`,
          );
      });
    });
  }

  /** Kills the repo's run, if any is active; resolves once its commands have closed. */
  function stop(repoId: string): Promise<void> {
    const entry = entries.get(repoId);
    if (!entry || !ACTIVE.includes(entry.run.status)) return Promise.resolve();
    if (entry.run.status !== "stopping") {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
      setStatus(entry, { status: "stopping" });
      void killAll(entry);
    }
    return entry.done;
  }

  return {
    /** Every repo's latest run. */
    list(): ProjectRun[] {
      return [...entries.values()].map((entry) => entry.run);
    },

    /** The tail of a repo's latest run's output; null when it has not run. */
    output(repoId: string): ProjectRunOutput | null {
      const entry = entries.get(repoId);
      if (!entry) return null;
      return {
        runId: entry.run.runId,
        end: entry.end,
        text: entry.output.slice(-MAX_PROJECT_OUTPUT_CHARS),
      };
    },

    /**
     * Starts the repo's run commands and returns at once. Throws
     * {@link RepoNotFoundError}, {@link InvalidRepoError} without run commands
     * or folder, and {@link RepoBusyError} while a run is active.
     */
    start(repoId: string): ProjectRun {
      const repo = repos.get(repoId);
      if (!repo) throw new RepoNotFoundError(repoId);
      const current = entries.get(repoId);
      if (current && ACTIVE.includes(current.run.status)) {
        throw new RepoBusyError(`${repo.name} is already running`);
      }
      if (repo.runCommands.length === 0) {
        throw new InvalidRepoError(`${repo.name} has no run commands`);
      }
      if (!existsSync(repo.path)) {
        throw new InvalidRepoError(`${repo.name} no longer exists at ${repo.path}`);
      }
      if (current?.flushTimer) clearTimeout(current.flushTimer);

      let resolveDone = () => {};
      const done = new Promise<void>((resolve) => (resolveDone = resolve));
      const entry: Entry = {
        run: {
          repoId,
          runId: randomUUID(),
          status: "starting",
          commands: [...repo.runCommands],
          startedAt: new Date(),
          endedAt: null,
          error: null,
        },
        children: [],
        open: repo.runCommands.length,
        failure: null,
        output: "",
        end: 0,
        pending: "",
        flushTimer: null,
        graceTimer: null,
        partials: new Map(),
        done,
        resolveDone,
      };
      entries.set(repoId, entry);
      const many = entry.run.commands.length > 1;
      entry.run.commands.forEach((command, index) =>
        writeLine(entry, `${many ? `[${index + 1}] ` : ""}$ ${command}`),
      );
      publishRun(entry);
      entry.graceTimer = setTimeout(() => {
        entry.graceTimer = null;
        if (entry.run.status === "starting" && !entry.failure) {
          setStatus(entry, { status: "running" });
        }
      }, graceMs);
      launch(entry, repo.path);
      return entry.run;
    },

    stop,

    /** Stops every run; resolves once all have closed. */
    async shutdown(): Promise<void> {
      await Promise.all([...entries.keys()].map(stop));
    },
  };
}
