import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_FILENAME,
  DataDirLockedError,
  acquireDataDirLock,
  type DataDirLock,
} from "./data-dir-lock.js";

const ORIGIN = "http://127.0.0.1:4711";

describe("acquireDataDirLock", () => {
  let dir: string;
  let lock: DataDirLock | undefined;

  const lockPath = () => join(dir, LOCK_FILENAME);
  const readLock = () => JSON.parse(readFileSync(lockPath(), "utf8")) as unknown;
  const writeLock = (contents: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath(), contents);
  };

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "blackwall-lock-")), "nested");
  });

  afterEach(() => {
    lock?.release();
    lock = undefined;
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("creates the data dir and writes our pid and origin", () => {
    lock = acquireDataDirLock(dir, ORIGIN);
    expect(lock.path).toBe(lockPath());
    expect(readLock()).toEqual({ pid: process.pid, origin: ORIGIN });
  });

  it("refuses while a live process holds the lock", () => {
    lock = acquireDataDirLock(dir, ORIGIN);
    let error: unknown;
    try {
      acquireDataDirLock(dir, "http://127.0.0.1:9999");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DataDirLockedError);
    expect((error as DataDirLockedError).message).toContain(ORIGIN);
    expect(readLock()).toEqual({ pid: process.pid, origin: ORIGIN });
  });

  it("replaces a lock left by a process that has exited", () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeLock(JSON.stringify({ pid: deadPid, origin: "http://127.0.0.1:1234" }));
    lock = acquireDataDirLock(dir, ORIGIN);
    expect(readLock()).toEqual({ pid: process.pid, origin: ORIGIN });
  });

  it("replaces a lock it can't parse", () => {
    writeLock("not json");
    lock = acquireDataDirLock(dir, ORIGIN);
    expect(readLock()).toEqual({ pid: process.pid, origin: ORIGIN });
  });

  it("removes the lock on release, once", () => {
    const first = acquireDataDirLock(dir, ORIGIN);
    first.release();
    expect(existsSync(lockPath())).toBe(false);
    expect(() => first.release()).not.toThrow();

    lock = acquireDataDirLock(dir, ORIGIN);
    expect(existsSync(lockPath())).toBe(true);
  });

  it("keeps a lock another process took over on release", () => {
    const first = acquireDataDirLock(dir, ORIGIN);
    writeLock(JSON.stringify({ pid: process.pid + 1, origin: "http://127.0.0.1:9999" }));
    first.release();
    expect(readLock()).toEqual({ pid: process.pid + 1, origin: "http://127.0.0.1:9999" });
  });
});
