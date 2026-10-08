import { execFile } from "node:child_process";
import { AGENT_CLIS, type AgentCli, type CliStatus } from "@blackwall/shared";

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
}

/** Runs `<cli> --version` to see whether the CLI is installed and which version. */
export function detectCli(cli: AgentCli, options: DetectCliOptions = {}): Promise<CliStatus> {
  const { command = cli, commandArgs = [], timeoutMs = VERSION_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    execFile(
      command,
      [...commandArgs, "--version"],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
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
