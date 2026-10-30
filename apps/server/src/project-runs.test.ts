import { InvalidRepoError, RepoBusyError, type ProjectRuns } from "@blackwall/core";
import { projectRunOutputSchema, projectRunSchema, type ProjectRun } from "@blackwall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const port = 4711;
const host = `127.0.0.1:${port}`;

const run: ProjectRun = {
  repoId: "r1",
  runId: "run1",
  status: "starting",
  commands: ["pnpm dev"],
  startedAt: new Date(0),
  endedAt: null,
  error: null,
};

let runs: {
  [K in "list" | "start" | "stop" | "output"]: ReturnType<typeof vi.fn<ProjectRuns[K]>>;
};

beforeEach(() => {
  runs = {
    list: vi.fn(() => [run]),
    start: vi.fn((repoId: string) => {
      if (repoId === "busy") throw new RepoBusyError("app is already running");
      if (repoId === "empty") throw new InvalidRepoError("app has no run commands");
      return run;
    }),
    stop: vi.fn(async () => undefined),
    output: vi.fn((repoId: string) =>
      repoId === "r1" ? { runId: "run1", end: 5, text: "ready" } : null,
    ),
  };
});

function request(path: string, method = "GET") {
  const { app } = createApp({ token: "test-token", getPort: () => port, projectRuns: runs });
  return app.request(`http://${host}${path}`, {
    method,
    headers: { host, cookie: `${tokenCookieName(port)}=test-token` },
  });
}

describe("project run routes", () => {
  it("starts a run", async () => {
    const res = await request("/api/repos/r1/run", "POST");
    expect(res.status).toBe(202);
    expect(projectRunSchema.parse(await res.json())).toEqual(run);
    expect(runs.start).toHaveBeenCalledWith("r1");
  });

  it("refuses a second run and a repo without run commands", async () => {
    expect((await request("/api/repos/busy/run", "POST")).status).toBe(409);
    expect((await request("/api/repos/empty/run", "POST")).status).toBe(400);
  });

  it("stops a run", async () => {
    expect((await request("/api/repos/r1/run", "DELETE")).status).toBe(204);
    expect(runs.stop).toHaveBeenCalledWith("r1");
  });

  it("returns the output, or null before the first run", async () => {
    const res = await request("/api/repos/r1/run/output");
    expect(projectRunOutputSchema.parse(await res.json())).toEqual({
      runId: "run1",
      end: 5,
      text: "ready",
    });
    expect(await (await request("/api/repos/r2/run/output")).json()).toBeNull();
  });

  it("lists every run", async () => {
    const res = await request("/api/project-runs");
    expect(projectRunSchema.array().parse(await res.json())).toEqual([run]);
  });
});
