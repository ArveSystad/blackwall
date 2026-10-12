import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { opencodeConfig } from "../permissions.js";
import { deferredRun, emittingRun } from "./deferred-run.js";
import { opencodeRateLimitFromText } from "./rate-limit.js";
import { runAgentProcess, type LineParser } from "./run-process.js";
import { inlinePrompt, withStructuredOutput } from "./structured-output.js";
import {
  AgentRunError,
  emptyUsage,
  type AgentAdapter,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type AgentUsage,
} from "./types.js";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** The name of the agent injected through config; the run pins it with `--agent`. */
export const OPENCODE_AGENT = "blackwall";

export interface OpencodeParserOptions {
  /** Model the run was started with; OpenCode's events do not name it. */
  model?: string;
  /** Clock for relative "try again in …" reset times. */
  now?: () => Date;
}

/**
 * Parses `opencode run --format json` output. Every event carries the session
 * id, announced once. `text` parts become messages; the final text is that of
 * the last step with text, since earlier steps lead up to tool calls. A tool
 * is reported only once it finished, so it yields its start and end together.
 * `step_finish` reports each model call's tokens and cost. OpenCode prints no
 * closing line, so `end` builds the result when the process exited cleanly.
 */
export function createOpencodeParser({
  model,
  now = () => new Date(),
}: OpencodeParserOptions = {}): LineParser {
  let sessionId: string | undefined;
  let step: string[] = [];
  let text = "";
  let errored = false;
  let limited = false;
  const usage = emptyUsage();

  return {
    push(line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!isObject(parsed)) return [];
      const events: AgentEvent[] = [];
      const part = isObject(parsed.part) ? parsed.part : {};

      const id = str(parsed.sessionID);
      if (!sessionId && id) {
        sessionId = id;
        events.push({ type: "session", sessionId: id, ...(model ? { model } : {}) });
      }

      switch (parsed.type) {
        case "step_start":
          step = [];
          break;
        case "text": {
          const content = str(part.text);
          if (content?.trim()) {
            step.push(content);
            text = step.join("\n\n");
            events.push({ type: "message", text: content });
          }
          break;
        }
        case "tool_use": {
          const state = isObject(part.state) ? part.state : {};
          if (state.status !== "completed" && state.status !== "error") break;
          const callId = str(part.callID) ?? str(part.id) ?? "";
          const ok = state.status === "completed";
          events.push(
            {
              type: "tool-call-start",
              id: callId,
              name: str(part.tool) ?? "unknown",
              input: state.input ?? {},
            },
            {
              type: "tool-call-end",
              id: callId,
              output: (ok ? str(state.output) : str(state.error)) ?? "",
              isError: !ok,
            },
          );
          break;
        }
        case "step_finish": {
          if (!isObject(part.tokens)) break;
          const tokens = part.tokens;
          const cache = isObject(tokens.cache) ? tokens.cache : {};
          const call: AgentUsage = {
            inputTokens: num(tokens.input),
            outputTokens: num(tokens.output) + num(tokens.reasoning),
            cacheReadTokens: num(cache.read),
            cacheWriteTokens: num(cache.write),
          };
          if (typeof part.cost === "number") call.costUsd = part.cost;
          usage.inputTokens += call.inputTokens;
          usage.outputTokens += call.outputTokens;
          usage.cacheReadTokens += call.cacheReadTokens;
          usage.cacheWriteTokens += call.cacheWriteTokens;
          if (call.costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + call.costUsd;
          events.push({ type: "usage", usage: call });
          break;
        }
        case "error": {
          errored = true;
          const error = isObject(parsed.error) ? parsed.error : {};
          const data = isObject(error.data) ? error.data : {};
          const message = str(data.message) ?? str(error.name) ?? "OpenCode CLI failed";
          const hit = limited ? undefined : opencodeRateLimitFromText(message, now());
          if (hit) {
            limited = true;
            events.push({ type: "rate-limit", ...hit });
          }
          events.push({ type: "error", message });
          break;
        }
      }
      return events;
    },
    end(exitCode) {
      if (exitCode !== 0 || errored || !sessionId) return [];
      return [{ type: "result", result: { sessionId, text, usage: { ...usage } } }];
    },
  };
}

export interface OpencodeArgsOptions extends Pick<AgentRunOptions, "cwd" | "model"> {
  /** Session to continue; a new run lets OpenCode create one. */
  sessionId?: string;
}

/**
 * Arguments for a headless `opencode run`. The prompt goes to stdin, which
 * OpenCode appends to the (empty) message, avoiding the Windows command-line
 * limit. The run always uses the injected `blackwall` agent, whose permissions
 * come from config rather than flags. `--dir` is explicit because OpenCode
 * otherwise takes its directory from `PWD`, not from the process's cwd.
 */
export function opencodeArgs({ cwd, model, sessionId }: OpencodeArgsOptions): string[] {
  return [
    "run",
    "--format",
    "json",
    "--agent",
    OPENCODE_AGENT,
    "--dir",
    cwd,
    ...(model ? ["--model", model] : []),
    ...(sessionId ? ["--session", sessionId] : []),
  ];
}

/** A per-run config home; `dispose` removes it (the links, never their targets). */
export interface OpencodeConfigHome {
  dir: string;
  dispose: () => Promise<void>;
}

/**
 * A stand-in `XDG_CONFIG_HOME` mirroring the real one without its `opencode`
 * entry. OpenCode always merges its global config from there (no setting
 * replaces it), and that config could add MCP servers, plugins or wider
 * permissions; but the agent's shell inherits the variable, so git, gh and
 * other XDG tools must still find their config. Directories are linked as
 * junctions (no admin rights needed on Windows; the type is ignored elsewhere);
 * a file that cannot be linked is skipped, never copied.
 */
export async function prepareConfigHome(
  base: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeConfigHome> {
  const dir = await mkdtemp(join(tmpdir(), "blackwall-opencode-"));
  const real = resolve(base.XDG_CONFIG_HOME || join(homedir(), ".config"));
  const entries = await readdir(real, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.name.toLowerCase() !== "opencode")
      .map(async (entry) => {
        const target = join(real, entry.name);
        const isDir =
          entry.isDirectory() ||
          (entry.isSymbolicLink() && (await stat(target).catch(() => undefined))?.isDirectory());
        await symlink(target, join(dir, entry.name), isDir ? "junction" : "file").catch(
          () => undefined,
        );
      }),
  );
  // `rm` removes links and junctions themselves without following them.
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Variables that would let the user's shell add OpenCode config beside ours. */
const INHERITED_CONFIG_VARS = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_PERMISSION"];

/**
 * Environment for an OpenCode run in `cwd`: the permissions as injected
 * config, the worktree's own OpenCode config (`opencode.json`, `.opencode/`)
 * disabled, and the global one hidden behind the mirrored config home. Auth
 * lives in the XDG data dir and HOME is untouched, so logins and
 * `~/.gitconfig` still apply. `PWD` is the worktree too: OpenCode reads its
 * directory from it, and an inherited one names wherever the server started.
 */
export function opencodeEnv(
  permissions: AgentRunOptions["permissions"],
  { cwd, configHome }: { cwd: string; configHome: string },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of INHERITED_CONFIG_VARS) delete env[name];
  return {
    ...env,
    PWD: cwd,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(permissions)),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    XDG_CONFIG_HOME: configHome,
  };
}

/** OpenCode's error when another process holds its SQLite store as it starts. */
const DATABASE_LOCKED = /database is locked/i;
const LOCKED_ATTEMPTS = 4;
const LOCKED_RETRY_MS = 500;

/**
 * Runs `spawn`, starting it again (after a growing, jittered pause) when it
 * failed only because OpenCode's shared database was locked by concurrent
 * runs starting up. Such a run emitted nothing but its error, which is held
 * back until it is clear that no retry follows.
 */
export function retryWhileLocked(
  spawn: () => AgentRun,
  { attempts = LOCKED_ATTEMPTS, delayMs = LOCKED_RETRY_MS } = {},
): AgentRun {
  return emittingRun(async (emit) => {
    for (let attempt = 1; ; attempt++) {
      const run = spawn();
      const errors: AgentEvent[] = [];
      let started = false;
      for await (const event of run) {
        if (!started && event.type === "error") {
          errors.push(event);
          continue;
        }
        started = true;
        errors.splice(0).forEach(emit);
        emit(event);
      }
      try {
        return await run.result;
      } catch (error) {
        const locked =
          !started &&
          error instanceof AgentRunError &&
          error.reason === "exit" &&
          DATABASE_LOCKED.test(error.stderr);
        if (!locked || attempt >= attempts) {
          errors.forEach(emit);
          throw error;
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * attempt * (0.5 + Math.random())),
      );
    }
  });
}

export interface OpencodeAdapterOptions {
  /** Executable to run. Default `opencode`. */
  command?: string;
  /** Arguments placed before the generated ones (e.g. a script for a fake CLI). */
  commandArgs?: readonly string[];
  /** Base environment; its `XDG_CONFIG_HOME` is the config home that gets mirrored. */
  env?: NodeJS.ProcessEnv;
  /** Pause before retrying a run that met a locked database, growing per attempt. */
  lockedRetryMs?: number;
}

/**
 * Runs OpenCode headless with JSON events. Permissions are enforced through
 * injected config with every other config source shut out (see
 * {@link opencodeEnv}). Structured output uses a prompt contract, validated
 * against the schema with one repair turn on the same session. `maxTurns` is
 * not supported and ignored.
 */
export function createOpencodeAdapter({
  command = "opencode",
  commandArgs = [],
  env,
  lockedRetryMs = LOCKED_RETRY_MS,
}: OpencodeAdapterOptions = {}): AgentAdapter {
  return {
    cli: "opencode",
    run({ cwd, prompt, systemPrompt, jsonSchema, resumeSessionId, model, permissions, signal }) {
      if (permissions.cli !== "opencode") {
        throw new Error(`Permissions for ${permissions.cli} cannot run on OpenCode`);
      }
      const base = env ?? process.env;
      return deferredRun("OpenCode", async () => {
        const home = await prepareConfigHome(base);
        const runEnv = opencodeEnv(permissions, { cwd, configHome: home.dir }, base);
        const spawn = (input: string, sessionId: string | undefined) =>
          retryWhileLocked(
            () =>
              runAgentProcess({
                command,
                args: [
                  ...commandArgs,
                  ...opencodeArgs({
                    cwd,
                    ...(model ? { model } : {}),
                    ...(sessionId ? { sessionId } : {}),
                  }),
                ],
                cwd,
                env: runEnv,
                input,
                signal,
                parser: createOpencodeParser(model ? { model } : {}),
                detectRateLimit: (text) => opencodeRateLimitFromText(text),
              }),
            { delayMs: lockedRetryMs },
          );

        const first = spawn(
          inlinePrompt({
            prompt,
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(jsonSchema ? { jsonSchema } : {}),
          }),
          resumeSessionId,
        );
        if (!jsonSchema) return { run: first, dispose: home.dispose };
        // The repair only runs after `first` succeeded, and this reaction was registered first.
        let sessionId = resumeSessionId;
        first.result.then(
          (result) => (sessionId = result.sessionId),
          () => undefined,
        );
        const run = withStructuredOutput(first, jsonSchema, (repair) => spawn(repair, sessionId));
        return { run, dispose: home.dispose };
      });
    },
  };
}
