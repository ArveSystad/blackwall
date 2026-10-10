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
import { backlogRoutes, promoteBacklogItem } from "./backlog.js";
import type { NewTaskServices, TaskPipeline } from "./tasks.js";

let opened: OpenedDatabase;
let repositories: Repositories;
let app: Hono;
let events: ServerEvent[];
let createTask: ReturnType<typeof vi.fn<TaskPipeline["createTask"]>>;
let repoId: string;
let settings: ReturnType<typeof createSettingsService>;
let newTask: NewTaskServices;

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
  events = [];
  createTask = vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" }));
  settings = createSettingsService({ settings: repositories.settings, tags: repositories.tags });
  newTask = {
    repos: { use: (id) => repositories.repos.get(id)! },
    resolveRoles: (overrides = {}) => ({ planner: "a-default", ...overrides }),
  };
  mount();
});

/** Mounts the routes with the current services; call again after changing `newTask`. */
function mount() {
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
        newTask,
        runner: settings,
      },
    ),
  );
}

afterEach(() => opened.close());

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://localhost/api/repos/${repoId}/backlog${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function create(body: Partial<NewBacklogItemInput>) {
  const res = await request("", {
    method: "POST",
    body: { origin: { kind: "free-text" }, freeText: `Do ${body.title ?? "it"}`, ...body },
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

  it("lists the task a follow-up came from", async () => {
    const source = repositories.tasks.create({
      title: "Plan the work",
      origin: { kind: "free-text" },
      repoId,
    });
    repositories.backlogItems.insert({
      repoId,
      title: "Follow-up",
      origin: { kind: "free-text" },
      freeText: "Do it",
      sourceTaskId: source.id,
    });
    const plain = await create({ title: "Plain" });
    const items = await list();
    expect(items.find((i) => i.title === "Follow-up")?.sourceTaskId).toBe(source.id);
    expect(items.find((i) => i.id === plain.id)?.sourceTaskId).toBeNull();
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

describe("new backlog item titles", () => {
  const jira = { kind: "jira-issue", key: "APP-1", connectionId: null } as const;

  it("uses the origin's title when none is given", async () => {
    newTask.originTitle = vi.fn(async () => "Fix the login");
    mount();
    expect((await create({ origin: jira, title: undefined })).title).toBe("Fix the login");
  });

  it("falls back to the Jira key or the first line", async () => {
    expect((await create({ origin: jira, title: undefined })).title).toBe("APP-1");
    const free = await create({ title: undefined, freeText: "First line\nMore" });
    expect(free.title).toBe("First line");
  });

  it("keeps an explicit title", async () => {
    newTask.originTitle = vi.fn(async () => "Fix the login");
    mount();
    expect((await create({ origin: jira, title: "Mine" })).title).toBe("Mine");
    expect(newTask.originTitle).not.toHaveBeenCalled();
  });
});

describe("starting new backlog items", () => {
  it("promotes at once when the runner is on, announcing once", async () => {
    const item = await create({ title: "Now", start: true });
    expect(item.status).toBe("promoted");
    expect(item.taskId).not.toBeNull();
    expect(repositories.tasks.get(item.taskId!)).toMatchObject({ title: "Now", status: "queued" });
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("leaves the item waiting when the repo's runner is off", async () => {
    settings.setRepoBacklogRunnerEnabled(repoId, false);
    const item = await create({ title: "Later", start: true });
    expect(item).toMatchObject({ status: "waiting", taskId: null });
    expect(createTask).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("leaves the item waiting when backlogs do not run automatically", async () => {
    settings.updateGeneral({ backlogRunner: false });
    const item = await create({ title: "Later", start: true });
    expect(item.status).toBe("waiting");
    expect(createTask).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("starts even while the repo's runner is halted", async () => {
    settings.setRepoBacklogHalt(repoId, "t1");
    expect((await create({ title: "Now", start: true })).status).toBe("promoted");
  });

  it("waits for open dependencies and starts once they are done", async () => {
    const open = await create({ title: "Open" });
    const blocked = await create({ title: "Blocked", dependsOn: [open.id], start: true });
    expect(blocked.status).toBe("waiting");
    expect(createTask).not.toHaveBeenCalled();

    const task = repositories.tasks.create({
      title: "Done",
      origin: { kind: "free-text" },
      repoId,
      status: "done",
    });
    repositories.backlogItems.markPromoted(open.id, task.id);
    const ready = await create({ title: "Ready", dependsOn: [open.id], start: true });
    expect(ready.status).toBe("promoted");
  });

  it("removes the item and announces nothing when promotion fails", async () => {
    createTask.mockImplementation(() => {
      throw new Error("boom");
    });
    const res = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, freeText: "Do it", start: true },
    });
    expect(res.status).toBe(500);
    expect(await list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it("inserts nothing for a stale repo", async () => {
    newTask.repos.use = () => {
      throw new Error("stale");
    };
    mount();
    const res = await request("", {
      method: "POST",
      body: { origin: { kind: "free-text" }, freeText: "Do it", start: true },
    });
    expect(res.status).toBe(500);
    expect(await list()).toEqual([]);
    expect(events).toEqual([]);
  });

  describe("GitHub issue start comments", () => {
    const origin = {
      kind: "github-issue",
      url: "https://github.com/acme/app/issues/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    } as const;
    const startComment = { body: "Work has started." };
    let commentOnIssue: ReturnType<typeof vi.fn<NonNullable<NewTaskServices["commentOnIssue"]>>>;

    beforeEach(() => {
      commentOnIssue = vi.fn(async () => ({ url: "https://github.com/acme/app/issues/7#c1" }));
      newTask.commentOnIssue = commentOnIssue;
      mount();
    });

    it("posts the comment before a task that starts now is created", async () => {
      const order: string[] = [];
      commentOnIssue.mockImplementation(async () => {
        order.push("comment");
        return { url: "x" };
      });
      createTask.mockImplementation((values) => {
        order.push("create");
        return repositories.tasks.create({ ...values, status: "queued" });
      });
      const item = await create({ title: "Export", origin, start: true, startComment });
      expect(item.status).toBe("promoted");
      expect(commentOnIssue).toHaveBeenCalledWith(origin, "Work has started.");
      expect(order).toEqual(["comment", "create"]);
    });

    it("posts nothing for an item that waits, or without a start comment", async () => {
      settings.setRepoBacklogRunnerEnabled(repoId, false);
      expect((await create({ title: "Later", origin, start: true, startComment })).status).toBe(
        "waiting",
      );
      settings.setRepoBacklogRunnerEnabled(repoId, true);
      await create({ title: "Now", origin, start: true });
      expect(commentOnIssue).not.toHaveBeenCalled();
    });

    it("adds nothing when the comment fails", async () => {
      commentOnIssue.mockRejectedValueOnce(new Error("github.com: access denied"));
      const res = await request("", {
        method: "POST",
        body: { origin, title: "Export", start: true, startComment },
      });
      expect(res.status).toBe(500);
      expect(await list()).toEqual([]);
      expect(createTask).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it("refuses a start comment on other origins", async () => {
      const res = await request("", {
        method: "POST",
        body: { origin: { kind: "free-text" }, freeText: "Do it", start: true, startComment },
      });
      expect(res.status).toBe(400);
    });
  });

  it("never promotes an item twice", async () => {
    const item = await create({ title: "Once" });
    const services = {
      pipeline: { createTask },
      newTask,
      backlogItems: repositories.backlogItems,
      broadcast: () => undefined,
    };
    promoteBacklogItem(item, services);
    expect(() => promoteBacklogItem(item, services)).toThrow("already promoted");
    expect(createTask).toHaveBeenCalledTimes(1);
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
