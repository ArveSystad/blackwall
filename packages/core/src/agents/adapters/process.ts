import { spawn, type ChildProcess } from "node:child_process";

const isWindows = process.platform === "win32";

export interface SpawnTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns a command so its whole process tree can be killed later with
 * {@link killTree}. On *nix the child leads a new process group; on Windows
 * `taskkill /T` walks the tree instead. stdio is piped.
 */
export function spawnTree(
  command: string,
  args: readonly string[],
  { cwd, env }: SpawnTreeOptions,
): ChildProcess {
  return spawn(command, args, {
    cwd,
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !isWindows,
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
