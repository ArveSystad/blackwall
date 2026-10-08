import { createInterface } from "node:readline";
import { killTree, spawnTree } from "./process.js";
import {
  AgentRunError,
  type AgentEvent,
  type AgentResult,
  type AgentRun,
  type AgentRunFailure,
} from "./types.js";

/** Keep at most this much stderr (the tail), for error messages. */
const STDERR_LIMIT = 64 * 1024;

/** Turns a CLI's JSONL output into normalized events, one line at a time. */
export interface LineParser {
  push(line: string): AgentEvent[];
}

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed. */
  input?: string;
  signal?: AbortSignal | undefined;
  parser: LineParser;
}

/**
 * Spawns a headless agent CLI and streams its parsed events. Events are
 * buffered, so `result` settles even if nobody iterates. The run succeeds once
 * the parser has produced a `result` event; otherwise `result` rejects and a
 * final `error` event describes why. Aborting kills the process tree.
 */
export function runAgentProcess({
  command,
  args,
  cwd,
  env,
  input,
  signal,
  parser,
}: RunProcessOptions): AgentRun {
  const queue: AgentEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;

  const emit = (event: AgentEvent) => {
    queue.push(event);
    wake?.();
  };

  let settle!: { resolve: (r: AgentResult) => void; reject: (e: AgentRunError) => void };
  const result = new Promise<AgentResult>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Callers that only iterate must not trigger an unhandled rejection.
  result.catch(() => undefined);

  let stderr = "";
  const fail = (reason: AgentRunFailure, message: string, exitCode: number | null) => {
    emit({ type: "error", message });
    settle.reject(new AgentRunError(reason, message, stderr, exitCode));
  };
  const end = () => {
    finished = true;
    wake?.();
  };

  if (signal?.aborted) {
    fail("aborted", "Run aborted", null);
    end();
  } else {
    start();
  }

  function start() {
    const child = spawnTree(command, args, { cwd, ...(env ? { env } : {}) });
    let final: AgentResult | undefined;
    let cliError: string | undefined;
    let aborted = false;
    let spawnError: Error | undefined;
    let completed = false;

    const onAbort = () => {
      aborted = true;
      void killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      spawnError = error;
      // A process that never started emits no `close` on every platform.
      if (child.pid === undefined) complete(null);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        for (const event of parser.push(line)) {
          if (event.type === "result") final = event.result;
          if (event.type === "error") cliError = event.message;
          emit(event);
        }
      });
    }

    // `close` fires after the process exited and its stdio streams closed.
    child.once("close", complete);

    function complete(exitCode: number | null) {
      if (completed) return;
      completed = true;
      signal?.removeEventListener("abort", onAbort);
      const tail = stderr.trim();
      if (aborted) {
        fail("aborted", "Run aborted", exitCode);
      } else if (spawnError) {
        fail("spawn", `Could not start ${command}: ${spawnError.message}`, exitCode);
      } else if (final) {
        settle.resolve(final);
      } else if (cliError !== undefined) {
        // The parser already emitted the error event.
        settle.reject(new AgentRunError("cli-error", cliError, stderr, exitCode));
      } else {
        fail(
          "exit",
          `${command} exited with code ${exitCode ?? "unknown"} without a result${tail ? `: ${tail}` : ""}`,
          exitCode,
        );
      }
      end();
    }
  }

  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const event = queue.shift();
        if (event) {
          yield event;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}
