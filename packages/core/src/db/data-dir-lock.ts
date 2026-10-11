import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isAlive } from "../agents/adapters/process.js";

export const LOCK_FILENAME = "blackwall.lock";

/** Another live blackwall process holds the data directory. */
export class DataDirLockedError extends Error {
  constructor(
    readonly dataDir: string,
    readonly pid: number,
    readonly origin: string,
  ) {
    super(`blackwall is already running at ${origin} (pid ${pid}) on data directory ${dataDir}`);
    this.name = "DataDirLockedError";
  }
}

export interface DataDirLock {
  /** Absolute path of the lock file. */
  path: string;
  /** Removes the lock file if it is still ours. Safe to call more than once. */
  release(): void;
}

interface LockContents {
  pid: number;
  origin: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

/** Undefined if the lock file can't be parsed; throws ENOENT if it is gone. */
function readLock(path: string): LockContents | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return undefined;
    }
    return { pid: parsed.pid, origin: typeof parsed.origin === "string" ? parsed.origin : "" };
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw error;
    return undefined;
  }
}

function removeLock(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/** Creates the lock file exclusively; false if it already exists. */
function tryCreate(path: string, contents: LockContents): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(contents));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Claims `dataDir` (creating it if needed) for this process by writing
 * `blackwall.lock` with our pid and `origin`. Throws {@link DataDirLockedError}
 * if a live process already holds it; a lock left by a dead process, or one
 * that can't be read, is replaced. `origin` is written to disk, so it must not
 * carry a token.
 */
export function acquireDataDirLock(dataDir: string, origin: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LOCK_FILENAME);
  const ours: LockContents = { pid: process.pid, origin };

  for (let attempt = 0; ; attempt++) {
    if (tryCreate(path, ours)) break;
    let holder: LockContents | undefined;
    try {
      holder = readLock(path);
    } catch {
      // Removed between our create and read: try again.
      holder = undefined;
    }
    if (holder && isAlive(holder.pid)) {
      throw new DataDirLockedError(dataDir, holder.pid, holder.origin);
    }
    // Stale: retry the exclusive create once; a winner's live pid makes us refuse above.
    if (attempt > 0) {
      throw new Error(`Could not take the data directory lock ${path}`);
    }
    removeLock(path);
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      try {
        if (readLock(path)?.pid !== process.pid) return;
      } catch {
        // Already gone.
        return;
      }
      removeLock(path);
    },
  };
}
