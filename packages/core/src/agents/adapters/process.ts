import { spawn, type ChildProcess } from "node:child_process";
import { resolveCommand } from "./resolve-command.js";

const isWindows = process.platform === "win32";

export interface SpawnTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Run `command` through the platform shell (`cmd.exe` / `/bin/sh`); `args` must be empty. */
  shell?: boolean;
}

/**
 * Spawns a command so its whole process tree can be killed later with
 * {@link killTree}. On *nix the child leads a new process group; on Windows
 * `taskkill /T` walks the tree instead. stdio is piped. Without `shell`,
 * npm `.cmd` shims on Windows are unwrapped by {@link resolveCommand}.
 */
export function spawnTree(
  command: string,
  args: readonly string[],
  { cwd, env, shell = false }: SpawnTreeOptions,
): ChildProcess {
  const resolved = shell
    ? { command, args: [] }
    : resolveCommand(command, { env: env ?? process.env });
  return spawn(resolved.command, [...resolved.args, ...args], {
    cwd,
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !isWindows,
    shell,
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills a process and every descendant. Windows: `taskkill /T /F`. *nix:
 * SIGTERM to the process group, then SIGKILL after `graceMs` if the leader
 * is still alive. Resolves once the kill has been issued.
 */
export async function killTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
  const { pid } = child;
  if (pid === undefined) return;
  if (isWindows) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  signalGroup(pid, "SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) {
    // The leader is gone, but descendants may linger in the group.
    signalGroup(pid, "SIGKILL");
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signalGroup(pid, "SIGKILL");
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      // Descendants that ignored SIGTERM.
      signalGroup(pid, "SIGKILL");
      resolve();
    });
  });
}
