import type { AgentCli, CliCheckResult, CliCheckStep } from "@blackwall/shared";
import { permissionsFor } from "../permissions.js";
import { mergeEnv } from "./env.js";
import { killTree, spawnTree } from "./process.js";
import { AgentRunError, type AgentAdapter } from "./types.js";

/**
 * The headless commands a CLI check runs, in order; the first must show the
 * CLI starts at all. The one place to change when a CLI gains a headless
 * account or status command. `claude doctor` is left out on purpose: it draws
 * an interactive screen and can't be relied on without a terminal. Copilot
 * has no command that reports its account without starting a session.
 */
export const CLI_CHECK_COMMANDS: Record<AgentCli, { label: string; args: string[] }[]> = {
  claude: [
    { label: "Version", args: ["--version"] },
    { label: "Account", args: ["auth", "status"] },
  ],
  copilot: [{ label: "Version", args: ["--version"] }],
  opencode: [
    { label: "Version", args: ["--version"] },
    { label: "Account", args: ["auth", "list"] },
  ],
};

/** The test prompt, small enough to cost next to nothing. */
export const CLI_CHECK_PROMPT = "Reply with exactly: OK";

const COMMAND_TIMEOUT_MS = 20_000;
const PROMPT_TIMEOUT_MS = 120_000;
/** Most output shown per step. */
export const CLI_CHECK_OUTPUT_LIMIT = 16 * 1024;
const STDERR_TAIL = 2_000;

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** `text` without ANSI escapes and carriage returns, capped at {@link CLI_CHECK_OUTPUT_LIMIT}. */
export function cleanCheckOutput(text: string): string {
  const clean = text.replace(ANSI, "").replace(/\r\n?/g, "\n").trim();
  return clean.length > CLI_CHECK_OUTPUT_LIMIT
    ? `${clean.slice(0, CLI_CHECK_OUTPUT_LIMIT)}\n… (output truncated)`
    : clean;
}

export interface CheckCliOptions {
  /** The repo's variables for the CLI, layered over `process.env`. */
  env?: Record<string, string>;
  /** Where the commands and the test prompt run: the repo's folder. */
  cwd?: string;
  /** Also send {@link CLI_CHECK_PROMPT} through this adapter, read-only. */
  prompt?: AgentAdapter;
  /** Executable to run. Default: the CLI's own name. */
  command?: string;
  /** Arguments placed before each command's own. */
  commandArgs?: readonly string[];
  /** Per command step. */
  timeoutMs?: number;
  /** For the test prompt. */
  promptTimeoutMs?: number;
}

function runStep(
  label: string,
  display: string,
  command: string,
  args: readonly string[],
  { cwd, env, timeoutMs }: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CliCheckStep> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null, text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        label,
        command: display,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        output: cleanCheckOutput(text),
        durationMs: Date.now() - started,
      });
    };
    const child = spawnTree(command, args, { cwd, env });
    // Closed at once: a check command must never wait for input.
    child.stdin?.end();
    const collect = (chunk: Buffer) => {
      // Keep a little more than is shown, so the cap still says "truncated".
      if (output.length <= CLI_CHECK_OUTPUT_LIMIT * 2) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
      finish(null, `${output}\nTimed out after ${Math.round(timeoutMs / 1000)} s`);
    }, timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(null, error.code === "ENOENT" ? `${command} not found on PATH` : error.message);
    });
    child.once("close", (code) => finish(code, output));
  });
}

async function promptStep(
  cli: AgentCli,
  adapter: AgentAdapter,
  {
    cwd,
    env,
    timeoutMs,
  }: { cwd: string; env: Record<string, string> | undefined; timeoutMs: number },
): Promise<CliCheckStep> {
  const started = Date.now();
  const step = (ok: boolean, exitCode: number | null, output: string): CliCheckStep => ({
    label: "Test prompt",
    command: CLI_CHECK_PROMPT,
    ok,
    exitCode,
    output: cleanCheckOutput(output),
    durationMs: Date.now() - started,
  });
  try {
    const run = adapter.run({
      cwd,
      prompt: CLI_CHECK_PROMPT,
      permissions: permissionsFor(cli, "read-only", {}, []),
      maxTurns: 1,
      signal: AbortSignal.timeout(timeoutMs),
      ...(env ? { env } : {}),
    });
    // Drain the events; only the result matters here.
    for await (const _event of run) void _event;
    const result = await run.result;
    return step(true, 0, result.text);
  } catch (error) {
    if (error instanceof AgentRunError) {
      const stderr = error.stderr.trim();
      const tail = stderr.length > STDERR_TAIL ? `…${stderr.slice(-STDERR_TAIL)}` : stderr;
      return step(false, error.exitCode, tail ? `${error.message}\n\n${tail}` : error.message);
    }
    return step(false, null, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Checks a CLI with a repo's environment: runs each of its
 * {@link CLI_CHECK_COMMANDS} in order (the rest are skipped when the first
 * fails), then, with `prompt`, one short read-only request. Never reports to
 * the quota service: a rate limit just shows as a failed step.
 */
export async function checkCli(
  cli: AgentCli,
  options: CheckCliOptions = {},
): Promise<CliCheckResult> {
  const {
    env: repoEnv,
    cwd = process.cwd(),
    prompt,
    command = cli,
    commandArgs = [],
    timeoutMs = COMMAND_TIMEOUT_MS,
    promptTimeoutMs = PROMPT_TIMEOUT_MS,
  } = options;
  const env = repoEnv ? mergeEnv(process.env, repoEnv) : process.env;
  const steps: CliCheckStep[] = [];
  let started = true;
  for (const [index, { label, args }] of CLI_CHECK_COMMANDS[cli].entries()) {
    const display = [cli, ...args].join(" ");
    if (!started) {
      steps.push({
        label,
        command: display,
        ok: false,
        exitCode: null,
        output: "Skipped: the CLI did not start",
        durationMs: 0,
      });
      continue;
    }
    const step = await runStep(label, display, command, [...commandArgs, ...args], {
      cwd,
      env,
      timeoutMs,
    });
    steps.push(step);
    if (index === 0 && !step.ok) started = false;
  }
  if (prompt) {
    steps.push(
      started
        ? await promptStep(cli, prompt, { cwd, env: repoEnv, timeoutMs: promptTimeoutMs })
        : {
            label: "Test prompt",
            command: CLI_CHECK_PROMPT,
            ok: false,
            exitCode: null,
            output: "Skipped: the CLI did not start",
            durationMs: 0,
          },
    );
  }
  return { cli, steps };
}
