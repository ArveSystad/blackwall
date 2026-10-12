import { execFile } from "node:child_process";
import { AGENT_CLIS, type AgentCli, type CliStatus } from "@blackwall/shared";
import { resolveCommand } from "./resolve-command.js";

const VERSION_TIMEOUT_MS = 15_000;

/** The first semver-looking token in `--version` output, e.g. `2.1.294 (Claude Code)`. */
export function parseCliVersion(output: string): string | null {
  return /\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(output)?.[0] ?? null;
}

export interface DetectCliOptions {
  /** Executable to run. Default: the CLI's own name. */
  command?: string;
  /** Arguments placed before `--version`. */
  commandArgs?: readonly string[];
  timeoutMs?: number;
  /** Environment for finding and running the CLI. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Runs `<cli> --version` to see whether the CLI is installed and which version. */
export function detectCli(cli: AgentCli, options: DetectCliOptions = {}): Promise<CliStatus> {
  const {
    command = cli,
    commandArgs = [],
    timeoutMs = VERSION_TIMEOUT_MS,
    env = process.env,
  } = options;
  const resolved = resolveCommand(command, { env });
  return new Promise((resolve) => {
    execFile(
      resolved.command,
      [...resolved.args, ...commandArgs, "--version"],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8", env },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          resolve({
            cli,
            installed: false,
            version: null,
            error: code === "ENOENT" ? `${command} not found on PATH` : error.message,
          });
          return;
        }
        resolve({
          cli,
          installed: true,
          version: parseCliVersion(`${stdout}\n${stderr}`),
          error: null,
        });
      },
    );
  });
}

/** Detects every supported agent CLI, in {@link AGENT_CLIS} order. */
export function detectClis(): Promise<CliStatus[]> {
  return Promise.all(AGENT_CLIS.map((cli) => detectCli(cli)));
}
