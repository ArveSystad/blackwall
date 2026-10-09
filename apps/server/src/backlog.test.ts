import {
  createQuotaTracker,
  createRepositories,
  createSettingsService,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  backlogItemSchema,
  backlogItemViewSchema,
  quotaStateSchema,
  repoBacklogRunnerSchema,
  taskSchema,
  type NewBacklogItemInput,
  type ServerEvent,
} from "@blackwall/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import { backlogRoutes } from "./backlog.js";
import type { TaskPipeline } from "./tasks.js";

let opened: OpenedDatabase;
let repositories: Repositories;
let app: Hono;
let events: ServerEvent[];
let createTask: ReturnType<typeof vi.fn<TaskPipeline["createTask"]>>;
let repoId: string;
let settings: ReturnType<typeof createSettingsService>;

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
  events = [];
  createTask = vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" }));
  settings = createSettingsService({ settings: repositories.settings, tags: repositories.tags });
  app = new Hono().route(
    "/api/repos/:repoId/backlog",
    backlogRoutes(
      {
        backlogItems: repositories.backlogItems,
        repos: repositories.repos,
        tasks: repositories.tasks,
      },
      {
        broadcast: (event) => events.push(event),
        pipeline: { createTask },
        newTask: {
          repos: { use: (id) => repositories.repos.get(id)! },
          resolveRoles: (overrides = {}) => ({ planner: "a-default", ...overrides }),
        },
        runner: settings,
      },
    ),
  );
});

afterEach(() => opened.close());

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://localhost/api/repos/${repoId}/backlog${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function create(body: Partial<NewBacklogItemInput> & { title: string }) {
  const res = await request("", {
    method: "POST",
    body: { origin: { kind: "free-text" }, freeText: `Do ${body.title}`, ...body },
  });
  expect(res.status).toBe(201);
  return backlogItemSchema.parse(await res.json());
}

async function list() {
  return backlogItemViewSchema.array().parse(await (await request("")).json());
}

describe("backlog routes", () => {
  it("creates items with unattended defaults and announces the change", async () => {
    const item = await create({ title: "Add dark mode" });
    expect(item).toMatchObject({
      repoId,
      title: "Add dark mode",
      status: "waiting",
      priority: "normal",
      triageMode: "intervene",
      taskId: null,
    });
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("rejects invalid input, unknown dependencies and missing repos", async () => {
    const tooLong = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, freeText: "x", title: "x".repeat(121) },
    });
    expect(tooLong.status).toBe(400);
    const noText = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, title: "x" },
    });
    expect(noText.status).toBe(400);
    const unknownDep = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, freeText: "x", title: "x", dependsOn: ["nope"] },
    });
    expect(unknownDep.status).toBe(400);

    // A dependency in another repo is not allowed either.
    const other = repositories.repos.create({ path: "/code/other", name: "other" });
    const foreign = repositories.backlogItems.insert({
      repoId: other.id,
      title: "Elsewhere",
      origin: { kind: "free-text" },
    });
    const crossRepo = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, freeText: "x", title: "x", dependsOn: [foreign.id] },
    });
    expect(crossRepo.status).toBe(400);

    const missingRepo = await app.request("http://localhost/api/repos/nope/backlog");
    expect(missingRepo.status).toBe(404);
    expect(events).toEqual([]);
  });

  it("lists in pick order with blocked annotations", async () => {
    const low = await create({ title: "Low", priority: "low" });
    const base = await create({ title: "Base" });
    const high = await create({ title: "High", priority: "high", dependsOn: [base.id] });

    const items = await list();
    expect(items.map((i) => i.title)).toEqual(["High", "Base", "Low"]);
    expect(items[0]).toMatchObject({ id: high.id, blocked: true, blockedBy: [base.id] });
    expect(items[1]).toMatchObject({ blocked: false, blockedBy: [] });

    // Done once promoted and its task is done.
    const task = repositories.tasks.create({
      title: "Base",
      origin: { kind: "free-text" },
      repoId,
      status: "done",
    });
    repositories.backlogItems.markPromoted(base.id, task.id);
    expect((await list()).find((i) => i.id === high.id)?.blocked).toBe(false);
    expect(low.position).toBe(0);
  });

  it("edits, pauses and rejects dependency cycles", async () => {
    const a = await create({ title: "A" });
    const b = await create({ title: "B", dependsOn: [a.id] });

    const paused = await request(`/${a.id}`, {
      method: "PATCH",
      body: { status: "paused", title: "A2", priority: "high" },
    });
    expect(paused.status).toBe(200);
    expect(backlogItemSchema.parse(await paused.json())).toMatchObject({
      status: "paused",
      title: "A2",
      priority: "high",
    });

    const cycle = await request(`/${a.id}`, { method: "PATCH", body: { dependsOn: [b.id] } });
    expect(cycle.status).toBe(400);
    const self = await request(`/${a.id}`, { method: "PATCH", body: { dependsOn: [a.id] } });
    expect(self.status).toBe(400);
    const promote = await request(`/${a.id}`, { method: "PATCH", body: { status: "promoted" } });
    expect(promote.status).toBe(400);
    expect((await request("/nope", { method: "PATCH", body: {} })).status).toBe(404);
  });

  it("reorders the whole backlog", async () => {
    const a = await create({ title: "A" });
    const b = await create({ title: "B" });
    const c = await create({ title: "C" });

    const partial = await request("/reorder", { method: "POST", body: { ids: [c.id, a.id] } });
    expect(partial.status).toBe(400);

    events = [];
    const res = await request("/reorder", { method: "POST", body: { ids: [c.id, a.id, b.id] } });
    expect(res.status).toBe(200);
    expect((await list()).map((i) => i.title)).toEqual(["C", "A", "B"]);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("deletes an item", async () => {
    const a = await create({ title: "A" });
    expect((await request(`/${a.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await list()).toEqual([]);
    expect((await request(`/${a.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("runs an item now as a normal queued task and links it", async () => {
    const item = await create({ title: "Add dark mode", agents: { implementer: "a-impl" } });
    events = [];

    const res = await request(`/${item.id}/run`, { method: "POST" });
    expect(res.status).toBe(201);
    const task = taskSchema.parse(await res.json());
    expect(task).toMatchObject({
      title: "Add dark mode",
      status: "queued",
      repoId,
      freeText: "Do Add dark mode",
      triageMode: "intervene",
      agents: { planner: "a-default", implementer: "a-impl" },
    });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(repositories.backlogItems.get(item.id)).toMatchObject({
      status: "promoted",
      taskId: task.id,
    });
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);

    expect((await request(`/${item.id}/run`, { method: "POST" })).status).toBe(409);
    const edit = await request(`/${item.id}`, { method: "PATCH", body: { title: "x" } });
    expect(edit.status).toBe(409);
  });
});

describe("backlog runner routes", () => {
  const runnerState = async (res: Response) => repoBacklogRunnerSchema.parse(await res.json());

  it("shows the runner on and not halted by default", async () => {
    expect(await runnerState(await request("/runner"))).toEqual({
      enabled: true,
      haltedTaskId: null,
      haltedAt: null,
    });
  });

  it("switches the repo's runner off and announces it", async () => {
    const res = await request("/runner", { method: "PATCH", body: { enabled: false } });
    expect(await runnerState(res)).toMatchObject({ enabled: false });
    expect(settings.repoBacklogRunner(repoId).enabled).toBe(false);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
    expect((await request("/runner", { method: "PATCH", body: { enabled: "no" } })).status).toBe(
      400,
    );
  });

  it("resumes a halted runner", async () => {
    settings.setRepoBacklogHalt(repoId, "t1");
    expect(await runnerState(await request("/runner"))).toMatchObject({ haltedTaskId: "t1" });
    const res = await request("/runner/resume", { method: "POST" });
    expect(await runnerState(res)).toMatchObject({ haltedTaskId: null, haltedAt: null });
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });
});

describe("backlog mount", () => {
  it("is served under /api/repos/:repoId/backlog behind the token", async () => {
    const port = 4711;
    const host = `127.0.0.1:${port}`;
    const full = createApp({
      token: "test-token",
      getPort: () => port,
      backlog: {
        backlogItems: repositories.backlogItems,
        repos: repositories.repos,
        tasks: repositories.tasks,
      },
    }).app;
    const url = `http://${host}/api/repos/${repoId}/backlog`;

    expect((await full.request(url, { headers: { host } })).status).toBe(401);
    const res = await full.request(url, {
      headers: { host, cookie: `${tokenCookieName(port)}=test-token` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("tells the runner about backlog changes and serves the quota state", async () => {
    const port = 4711;
    const host = `127.0.0.1:${port}`;
    const onChanged = vi.fn();
    const quota = createQuotaTracker({ settings: repositories.settings });
    quota.report("copilot", { resetsAt: new Date(Date.now() + 60_000) });
    const full = createApp({
      token: "test-token",
      getPort: () => port,
      backlog: {
        backlogItems: repositories.backlogItems,
        repos: repositories.repos,
        tasks: repositories.tasks,
        onChanged,
      },
      quota,
    }).app;
    const headers = {
      host,
      cookie: `${tokenCookieName(port)}=test-token`,
      "content-type": "application/json",
    };

    const created = await full.request(`http://${host}/api/repos/${repoId}/backlog`, {
      method: "POST",
      headers,
      body: JSON.stringify({ origin: { kind: "free-text" }, title: "A", freeText: "Do A" }),
    });
    expect(created.status).toBe(201);
    expect(onChanged).toHaveBeenCalledWith(repoId);

    const res = await full.request(`http://${host}/api/quota`, { headers });
    const state = quotaStateSchema.array().parse(await res.json());
    expect(state.map((s) => [s.cli, s.pausedUntil !== null])).toEqual([
      ["claude", false],
      ["copilot", true],
    ]);
  });
});
