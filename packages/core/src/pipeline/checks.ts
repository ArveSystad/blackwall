import { killTree, spawnTree } from "../agents/adapters/process.js";

/** Check output kept per command: the tail, where build and test failures are reported. */
export const MAX_CHECK_OUTPUT_CHARS = 20_000;

/** A check command running longer than this is killed and counts as failed. */
export const CHECK_TIMEOUT_MS = 20 * 60_000;

export interface CheckRunOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface CheckOutcome {
  /** Exit code; null when the command was killed (timeout or abort) or could not start. */
  exitCode: number | null;
  /** Combined stdout and stderr, cut to its last {@link MAX_CHECK_OUTPUT_CHARS} characters. */
  output: string;
  timedOut: boolean;
}

/** Runs one check command; resolves with its outcome rather than throwing on failure. */
export type CheckRunner = (command: string, options: CheckRunOptions) => Promise<CheckOutcome>;

const cutMarker = (dropped: number) =>
  dropped > 0 ? `[… ${dropped} earlier characters cut]\n` : "";

/**
 * Runs a repo check command (e.g. `pnpm run test`) through the platform shell
 * in the worktree. stdin is closed, so a command that prompts fails rather
 * than hangs. Abort and timeout kill the whole process tree.
 */
export const runCheckCommand: CheckRunner = (
  command,
  { cwd, signal, timeoutMs = CHECK_TIMEOUT_MS },
) =>
  new Promise((resolve) => {
    let output = "";
    let cut = 0;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      // Bound memory for chatty commands; only the tail is kept anyway.
      if (output.length > MAX_CHECK_OUTPUT_CHARS * 2) {
        cut += output.length - MAX_CHECK_OUTPUT_CHARS;
        output = output.slice(-MAX_CHECK_OUTPUT_CHARS);
      }
    };

    const child = spawnTree(command, [], {
      cwd,
      shell: true,
      env: { ...process.env, CI: process.env.CI ?? "1" },
    });
    child.stdin?.end();
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const kill = () => void killTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (timedOut) output += `\n[Timed out after ${Math.round(timeoutMs / 1000)}s]`;
      const kept = output.slice(-MAX_CHECK_OUTPUT_CHARS);
      const dropped = cut + output.length - kept.length;
      resolve({ exitCode, output: cutMarker(dropped) + kept, timedOut });
    };
    child.once("error", (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.once("close", (code) => finish(timedOut || signal.aborted ? null : code));
  });
