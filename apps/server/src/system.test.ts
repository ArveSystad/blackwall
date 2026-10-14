import { DatabaseBusyError, type SystemSnapshot } from "@blackwall/core";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

const snapshot: SystemSnapshot = {
  dataDir: "/home/me/.blackwall",
  database: {
    path: "/home/me/.blackwall/blackwall.db",
    fileBytes: 4096,
    walBytes: 0,
    shmBytes: 32768,
    totalBytes: 36864,
    dbstat: true,
    tables: [{ name: "step_events", rows: 3, bytes: 4096 }],
    migrations: { applied: 17, available: 17, latest: "0016_repo_default_branch" },
  },
  worktrees: { count: 1, artifactCount: 2, artifactBytes: 20, totalBytes: null },
  runningTasks: 0,
};

function setup(compact = vi.fn(() => Promise.resolve({ info: snapshot, freedBytes: 1024 }))) {
  const system = {
    snapshot: vi.fn(({ worktreeSizes = false } = {}) =>
      Promise.resolve({
        ...snapshot,
        worktrees: { ...snapshot.worktrees, totalBytes: worktreeSizes ? 100 : null },
      }),
    ),
    compact,
  };
  const { app } = createApp({ token: launchToken, getPort: () => port, system });
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`http://${host}${path}`, { ...init, headers: { host, cookie } });
  return { system, call };
}

describe("system routes", () => {
  it("returns the snapshot with the runtime", async () => {
    const { system, call } = setup();
    const res = await call("/api/system");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { runtime: { node: string } };
    expect(body).toMatchObject(snapshot);
    expect(body.runtime.node).toBe(process.version);
    expect(system.snapshot).toHaveBeenCalledWith({ worktreeSizes: false });
  });

  it("forwards the worktree size request", async () => {
    const { system, call } = setup();
    const res = await call("/api/system?worktreeSizes=1");
    expect(((await res.json()) as typeof snapshot).worktrees.totalBytes).toBe(100);
    expect(system.snapshot).toHaveBeenCalledWith({ worktreeSizes: true });
  });

  it("compacts the database", async () => {
    const { call } = setup();
    const res = await call("/api/system/compact", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ info: snapshot, freedBytes: 1024 });
  });

  it("refuses to compact while a task runs", async () => {
    const { call } = setup(vi.fn(() => Promise.reject(new DatabaseBusyError())));
    const res = await call("/api/system/compact", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Compacting waits until no task is running" });
  });
});
