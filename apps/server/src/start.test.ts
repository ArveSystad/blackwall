import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositories, openDatabase } from "@blackwall/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shutdown } from "./shutdown.js";
import { startBlackwall, type RunningBlackwall } from "./start.js";

const shutdowns: Shutdown[] = [];

vi.mock("./shutdown.js", async (importActual) => {
  const actual = await importActual<typeof import("./shutdown.js")>();
  return {
    ...actual,
    createShutdown: (...args: Parameters<typeof actual.createShutdown>) => {
      const shutdown = actual.createShutdown(...args);
      shutdowns.push(shutdown);
      return shutdown;
    },
  };
});

let dataDir: string;
let running: RunningBlackwall | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "blackwall-start-"));
  shutdowns.length = 0;
});

afterEach(async () => {
  await running?.shutdown();
  running = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function start(port = 0) {
  return startBlackwall({ port, dev: false, webDevOrigin: "http://127.0.0.1:5173", dataDir });
}

describe("startBlackwall", () => {
  it("returns the launch URL and the port it listens on", async () => {
    running = await start();
    expect(running.launchUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(running.port).toBeGreaterThan(0);
    expect(running.launchUrl).toContain(`:${running.port}/`);
  });

  it("counts the running agent steps", async () => {
    running = await start();
    expect(running.runningAgents()).toBe(0);

    const opened = openDatabase(dataDir);
    try {
      const r = createRepositories(opened.db);
      const repo = r.repos.create({ path: "/code/app", name: "app" });
      const task = r.tasks.create({
        title: "Fix login",
        origin: { kind: "free-text" },
        repoId: repo.id,
      });
      const run = r.runs.create(task.id);
      const agent = r.agents.create({ name: "coder", eligibleStages: ["implement"] });
      r.steps.create({ runId: run.id, stage: "implement", agentId: agent.id, status: "running" });
    } finally {
      opened.close();
    }

    expect(running.runningAgents()).toBe(1);
  });

  it("closes the server on shutdown, and a second shutdown resolves", async () => {
    running = await start();
    const url = `http://127.0.0.1:${running.port}/api/health`;
    await running.shutdown();
    await expect(fetch(url)).rejects.toThrow();
    await expect(running.shutdown()).resolves.toBeUndefined();
  });

  it("runs the shutdown hooks and rethrows when startup fails", async () => {
    const occupied: Server = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const { port } = occupied.address() as { port: number };
    try {
      let runCalled = false;
      const failure = start(port).catch((error: unknown) => {
        // The hooks have run (and closed the database) before the rejection settles.
        runCalled = vi.mocked(shutdowns[0]!.run).mock.calls.length > 0;
        throw error;
      });
      // Spy on the instance startBlackwall created, before startServer fails.
      expect(shutdowns).toHaveLength(1);
      vi.spyOn(shutdowns[0]!, "run");
      await expect(failure).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(runCalled).toBe(true);
    } finally {
      await new Promise((resolve) => occupied.close(resolve));
    }
  });
});
