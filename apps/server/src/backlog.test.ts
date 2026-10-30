import {
  checkReferenceRepoIds,
  MissingCredentialError,
  createQuotaTracker,
  createRepositories,
  createSettingsService,
  openDatabase,
  resolveClis,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  backlogItemSchema,
  backlogItemViewSchema,
  newBacklogItemInputSchema,
  quotaStateSchema,
  repoBacklogRunnerSchema,
  taskSchema,
  type NewBacklogItemInput,
  type RepoIssue,
  type RepoIssues,
  type RepoJiraIssue,
  type RepoJiraIssues,
  type ServerEvent,
} from "@blackwall/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import {
  addBacklogItem,
  BacklogInputError,
  backlogRoutes,
  importRemoteIssue,
  promoteBacklogItem,
} from "./backlog.js";
import { errorResponse } from "./errors.js";
import type { NewTaskServices, TaskPipeline } from "./tasks.js";

let opened: OpenedDatabase;
let repositories: Repositories;
let app: Hono;
let events: ServerEvent[];
let createTask: ReturnType<typeof vi.fn<TaskPipeline["createTask"]>>;
let autopilotRepo: ReturnType<typeof vi.fn<TaskPipeline["autopilotRepo"]>>;
let repoId: string;
let settings: ReturnType<typeof createSettingsService>;
let newTask: NewTaskServices;

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
  events = [];
  createTask = vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" }));
  autopilotRepo = vi.fn(async () => undefined);
  settings = createSettingsService({ settings: repositories.settings, tags: repositories.tags });
  newTask = {
    repos: {
      use: (id) => repositories.repos.get(id)!,
      checkReferenceRepos: (id, ids) => checkReferenceRepoIds(repositories.repos, id, ids),
    },
    resolveRoles: (overrides = {}) => ({ planner: "a-default", ...overrides }),
    resolveClis,
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
        pipeline: { createTask, autopilotRepo },
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
    const base = await create({ title: "Base" });
    const head = await create({ title: "Head", dependsOn: [base.id] });
    const later = await create({ title: "Later" });

    const items = await list();
    expect(items.map((i) => i.title)).toEqual(["Base", "Head", "Later"]);
    expect(items[0]).toMatchObject({ blocked: false, blockedBy: [] });
    expect(items[1]).toMatchObject({ id: head.id, blocked: true, blockedBy: [base.id] });

    // Done once promoted and its task is done.
    const task = repositories.tasks.create({
      title: "Base",
      origin: { kind: "free-text" },
      repoId,
      status: "done",
    });
    repositories.backlogItems.markPromoted(base.id, task.id);
    expect((await list()).find((i) => i.id === head.id)?.blocked).toBe(false);
    expect(later.position).toBe(2);
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
      body: { status: "paused", title: "A2" },
    });
    expect(paused.status).toBe(200);
    expect(backlogItemSchema.parse(await paused.json())).toMatchObject({
      status: "paused",
      title: "A2",
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

  it("stores an item's CLI choices and promotes it on the repo's CLI, keeping real overrides", async () => {
    repositories.repos.update(repoId, { defaultCli: "copilot" });
    const item = await create({
      agents: { implementer: "a-impl" },
      agentClis: { "a-impl": "claude", "a-default": "claude" },
    });
    expect(item.agentClis).toEqual({ "a-impl": "claude", "a-default": "claude" });
    const patched = await request(`/${item.id}`, {
      method: "PATCH",
      body: { agentClis: { "a-impl": "claude", "a-default": "copilot", "a-gone": "claude" } },
    });
    expect(backlogItemSchema.parse(await patched.json()).agentClis).toEqual({
      "a-impl": "claude",
      "a-default": "copilot",
      "a-gone": "claude",
    });

    const res = await request(`/${item.id}/run`, { method: "POST" });
    // An agent outside the roles and a choice equal to the repo's CLI are dropped.
    expect(taskSchema.parse(await res.json())).toMatchObject({
      cli: "copilot",
      agentClis: { "a-impl": "claude" },
    });
  });

  it("promotes an item without reference repos on the repo's list as of promotion", async () => {
    const lib = repositories.repos.create({ path: "/code/lib", name: "lib" });
    const item = await create({});
    expect(item.referenceRepoIds).toBeNull();
    repositories.repos.update(repoId, { referenceRepoIds: [lib.id] });

    const res = await request(`/${item.id}/run`, { method: "POST" });
    expect(taskSchema.parse(await res.json()).referenceRepoIds).toEqual([lib.id]);
  });

  it("stores whether an item works in the repo folder and promotes it so", async () => {
    const item = await create({ inRepo: true });
    expect(item.inRepo).toBe(true);
    const res = await request(`/${item.id}/run`, { method: "POST" });
    expect(taskSchema.parse(await res.json()).inRepo).toBe(true);

    const plain = await create({});
    expect(plain.inRepo).toBe(false);
    const edited = await request(`/${plain.id}`, { method: "PATCH", body: { inRepo: true } });
    expect(backlogItemSchema.parse(await edited.json()).inRepo).toBe(true);
  });

  it("stores an item's reference repos and promotes it with them", async () => {
    const lib = repositories.repos.create({ path: "/code/lib", name: "lib" });
    const api = repositories.repos.create({ path: "/code/api", name: "api" });
    repositories.repos.update(repoId, { referenceRepoIds: [lib.id] });
    const item = await create({ referenceRepoIds: [api.id] });
    expect(item.referenceRepoIds).toEqual([api.id]);

    const cleared = await request(`/${item.id}`, {
      method: "PATCH",
      body: { referenceRepoIds: [] },
    });
    expect(backlogItemSchema.parse(await cleared.json()).referenceRepoIds).toEqual([]);

    const res = await request(`/${item.id}/run`, { method: "POST" });
    expect(taskSchema.parse(await res.json()).referenceRepoIds).toEqual([]);
  });

  it("rejects reference repos that are unknown, repeated or the repo itself", async () => {
    const lib = repositories.repos.create({ path: "/code/lib", name: "lib" });
    const item = await create({});
    events = [];
    // The app maps the thrown InvalidRepoError to a 400.
    app = new Hono().onError(errorResponse).route("/", app);
    for (const referenceRepoIds of [["missing"], [repoId], [lib.id, lib.id]]) {
      const created = await request("", {
        method: "POST",
        body: { origin: { kind: "free-text" }, freeText: "x", referenceRepoIds },
      });
      expect(created.status).toBe(400);
      const patched = await request(`/${item.id}`, { method: "PATCH", body: { referenceRepoIds } });
      expect(patched.status).toBe(400);
    }
    expect(await list()).toHaveLength(1);
    expect(repositories.backlogItems.get(item.id)?.referenceRepoIds).toBeNull();
    expect(events).toEqual([]);
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

  it("waits for an item whose task is still running", async () => {
    const started = await create({ title: "Started" });
    const task = repositories.tasks.create({
      title: "Started",
      origin: { kind: "free-text" },
      repoId,
      status: "running",
    });
    repositories.backlogItems.markPromoted(started.id, task.id);
    const after = await create({ title: "After", dependsOn: [started.id], start: true });
    expect(after).toMatchObject({ status: "waiting", taskId: null });
    expect(createTask).not.toHaveBeenCalled();
    expect((await list()).find((i) => i.id === after.id)).toMatchObject({
      blocked: true,
      blockedBy: [started.id],
    });
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

  it("adds and starts an item directly, as voice does, only when both switches are on", async () => {
    const stores = {
      backlogItems: repositories.backlogItems,
      repos: repositories.repos,
      tasks: repositories.tasks,
    };
    const services = {
      broadcast: (event: ServerEvent) => void events.push(event),
      pipeline: { createTask, autopilotRepo },
      newTask,
      runner: settings,
    };
    const input = (title: string) =>
      newBacklogItemInputSchema.parse({
        origin: { kind: "free-text" },
        title,
        freeText: "Do it",
        start: true,
      });
    const started = await addBacklogItem(stores, services, repoId, input("Now"));
    expect(started).toMatchObject({ status: "promoted", title: "Now" });
    expect(createTask).toHaveBeenCalledTimes(1);

    settings.updateGeneral({ backlogRunner: false });
    const waiting = await addBacklogItem(stores, services, repoId, input("Later"));
    expect(waiting).toMatchObject({ status: "waiting", taskId: null });
    settings.updateGeneral({ backlogRunner: true });
    settings.setRepoBacklogRunnerEnabled(repoId, false);
    expect((await addBacklogItem(stores, services, repoId, input("Later 2"))).status).toBe(
      "waiting",
    );
    expect(createTask).toHaveBeenCalledTimes(1);

    await expect(
      addBacklogItem(stores, services, repoId, { ...input("Bad"), dependsOn: ["nope"] }),
    ).rejects.toThrow(new BacklogInputError("Unknown dependencies in this repo: nope"));
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

describe("stacked pull requests", () => {
  const pr = (number: number) =>
    ({
      kind: "github-pr",
      url: `https://github.com/acme/app/pull/${number}`,
      owner: "acme",
      repo: "app",
      number,
      connectionId: null,
    }) as const;
  const member = (number: number, baseRef: string) => ({
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    headRef: `b${number}`,
    baseRef,
  });
  const STACK = [member(41, "main"), member(42, "b41"), member(43, "b42")];
  let pullRequestStack: ReturnType<typeof vi.fn<NonNullable<NewTaskServices["pullRequestStack"]>>>;

  beforeEach(() => {
    pullRequestStack = vi.fn(async () => STACK);
    newTask.pullRequestStack = pullRequestStack;
    mount();
  });

  const others = async (main: string) => (await list()).filter((i) => i.id !== main);

  it("links the item to its stack and adds waiting Review PR items for the other PRs", async () => {
    settings.setRepoBacklogRunnerEnabled(repoId, false);
    const item = await create({
      title: "Middle",
      origin: pr(42),
      mode: "work",
      agents: { implementer: "a-impl" },
      agentClis: { "a-impl": "copilot" },
      referenceRepoIds: [],
      triageMode: "pause",
    });
    expect(item.mode).toBe("work");
    expect(item.origin).toEqual({ ...pr(42), stack: { prs: [41, 42, 43] } });
    expect(pullRequestStack).toHaveBeenCalledWith(pr(42));

    const siblings = await others(item.id);
    expect(siblings.map((i) => i.origin)).toEqual([
      { ...pr(41), stack: { prs: [41, 42, 43] } },
      { ...pr(43), stack: { prs: [41, 42, 43] } },
    ]);
    for (const sibling of siblings) {
      expect(sibling).toMatchObject({
        mode: "review",
        freeText: "",
        status: "waiting",
        agents: { implementer: "a-impl" },
        agentClis: { "a-impl": "copilot" },
        referenceRepoIds: [],
        triageMode: "pause",
        dependsOn: [],
      });
      expect(sibling).not.toHaveProperty("priority");
    }
    expect(siblings.map((i) => i.title)).toEqual(["PR 41", "PR 43"]);
    expect(events).toEqual([
      { type: "backlog.changed", payload: { repoId } },
      { type: "backlog.changed", payload: { repoId } },
    ]);
  });

  it("promotes only the main item when it starts now", async () => {
    const item = await create({ title: "Middle", origin: pr(42), mode: "review", start: true });
    expect(item.status).toBe("promoted");
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(repositories.tasks.get(item.taskId!)?.origin).toEqual({
      ...pr(42),
      stack: { prs: [41, 42, 43] },
    });
    const siblings = await others(item.id);
    expect(siblings.map((i) => i.status)).toEqual(["waiting", "waiting"]);
    expect(events.at(-1)).toEqual({ type: "backlog.changed", payload: { repoId } });
  });

  it("skips PRs an unarchived task or a waiting item already works on", async () => {
    repositories.tasks.create({
      title: "Bottom",
      origin: pr(41),
      mode: "review",
      repoId,
      status: "queued",
    });
    const archived = repositories.tasks.create({
      title: "Old",
      origin: pr(43),
      mode: "review",
      repoId,
      status: "done",
    });
    repositories.tasks.update(archived.id, { archivedAt: new Date() });
    const item = await create({ title: "Middle", origin: pr(42), mode: "review" });
    expect(
      (await others(item.id)).map((i) => i.origin.kind === "github-pr" && i.origin.number),
    ).toEqual([43]);

    // Adding the top PR now finds every other PR tracked.
    events.length = 0;
    const top = await create({ title: "Top", origin: pr(43), mode: "review" });
    expect((await list()).filter((i) => i.id !== top.id)).toHaveLength(2);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("adds one unstacked item when discovery fails", async () => {
    pullRequestStack.mockRejectedValueOnce(new Error("github.com: rate limited"));
    const item = await create({ title: "Middle", origin: pr(42), mode: "review" });
    expect(item.origin).toEqual(pr(42));
    expect(await list()).toHaveLength(1);
  });

  it("adds nothing when the token is missing", async () => {
    pullRequestStack.mockRejectedValueOnce(
      new MissingCredentialError("github", "github.com", null),
    );
    const res = await request("", {
      method: "POST",
      body: { origin: pr(42), mode: "review", title: "Middle", start: true },
    });
    expect(res.status).toBe(500);
    expect(await list()).toEqual([]);
    expect(createTask).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("sets no stack for a PR that is not stacked", async () => {
    pullRequestStack.mockResolvedValueOnce(undefined);
    expect((await create({ title: "Alone", origin: pr(42), mode: "review" })).origin).toEqual(
      pr(42),
    );
    pullRequestStack.mockResolvedValueOnce([member(42, "main")]);
    expect((await create({ title: "Alone", origin: pr(50), mode: "review" })).origin).toEqual(
      pr(50),
    );
    expect(await list()).toHaveLength(2);
  });

  describe("a client-sent stack", () => {
    const madeUp = { ...pr(42), stack: { prs: [1, 2] } };

    it("is dropped when discovery finds no stack", async () => {
      pullRequestStack.mockResolvedValueOnce([member(42, "main")]);
      expect((await create({ title: "x", origin: madeUp, mode: "review" })).origin).toEqual(pr(42));
    });

    it("is dropped when discovery throws", async () => {
      pullRequestStack.mockRejectedValueOnce(new Error("boom"));
      expect((await create({ title: "x", origin: madeUp, mode: "review" })).origin).toEqual(pr(42));
    });

    it("is dropped without discovery", async () => {
      delete newTask.pullRequestStack;
      mount();
      expect((await create({ title: "x", origin: madeUp, mode: "review" })).origin).toEqual(pr(42));
    });

    it("is replaced by the discovered stack", async () => {
      expect((await create({ title: "x", origin: madeUp, mode: "review" })).origin).toEqual({
        ...pr(42),
        stack: { prs: [41, 42, 43] },
      });
    });
  });
});

describe("backlog runner routes", () => {
  const runnerState = async (res: Response) => repoBacklogRunnerSchema.parse(await res.json());

  it("shows the runner on and not halted by default", async () => {
    expect(await runnerState(await request("/runner"))).toEqual({
      enabled: true,
      haltedTaskId: null,
      haltedAt: null,
      autonomous: false,
      includeRemoteIssues: false,
    });
  });

  it("switches remote issues on and announces it", async () => {
    const res = await request("/runner", { method: "PATCH", body: { includeRemoteIssues: true } });
    expect(await runnerState(res)).toMatchObject({ enabled: true, includeRemoteIssues: true });
    expect(settings.repoBacklogRunner(repoId).includeRemoteIssues).toBe(true);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
    const bad = await request("/runner", { method: "PATCH", body: { includeRemoteIssues: 1 } });
    expect(bad.status).toBe(400);
  });

  it("switches autonomous mode on, moving on tasks already at a gate, and off", async () => {
    const on = await request("/runner", { method: "PATCH", body: { autonomous: true } });
    expect(await runnerState(on)).toMatchObject({ enabled: true, autonomous: true });
    expect(settings.repoBacklogRunner(repoId).autonomous).toBe(true);
    expect(autopilotRepo).toHaveBeenCalledExactlyOnceWith(repoId);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);

    const off = await request("/runner", { method: "PATCH", body: { autonomous: false } });
    expect(await runnerState(off)).toMatchObject({ autonomous: false });
    expect(autopilotRepo).toHaveBeenCalledTimes(1);
  });

  it("refuses a runner update with nothing or the wrong type to set", async () => {
    for (const body of [{}, { autonomous: "yes" }]) {
      expect((await request("/runner", { method: "PATCH", body })).status).toBe(400);
    }
    expect(settings.repoBacklogRunner(repoId).autonomous).toBe(false);
    expect(autopilotRepo).not.toHaveBeenCalled();
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

describe("importRemoteIssue", () => {
  const issueUrl = (n: number) => `https://github.com/acme/app/issues/${n}`;
  const issue = (number: number, patch: Partial<RepoIssue> = {}): RepoIssue => ({
    host: "github.com",
    owner: "acme",
    repo: "app",
    number,
    title: `Issue ${number}`,
    url: issueUrl(number),
    author: "octocat",
    updatedAt: new Date("2026-10-09T12:00:00Z"),
    repoId,
    connectionId: "c1",
    assignees: [],
    ...patch,
  });
  const origin = (number: number) => ({
    kind: "github-issue" as const,
    url: issueUrl(number),
    owner: "acme",
    repo: "app",
    number,
    connectionId: "c1",
  });

  const jiraIssue = (key: string, patch: Partial<RepoJiraIssue> = {}): RepoJiraIssue => ({
    host: "acme.atlassian.net",
    key,
    title: `Jira ${key}`,
    url: `https://acme.atlassian.net/browse/${key}`,
    issueType: "Story",
    status: "To Do",
    author: "Ada",
    assignee: null,
    updatedAt: new Date("2026-10-09T12:00:00Z"),
    repoId,
    connectionId: "c1",
    ...patch,
  });
  const jiraOrigin = (key: string) => ({ kind: "jira-issue" as const, key, connectionId: "c1" });
  const jiraListed = (...issues: RepoJiraIssue[]) =>
    vi.fn(async (): Promise<RepoJiraIssues> => ({ issues, errors: [] }));

  function run(
    listed: RepoIssues,
    viewerLogin = vi.fn(async () => "me"),
    listJiraIssues = jiraListed(),
  ) {
    const repo = repositories.repos.get(repoId)!;
    return importRemoteIssue(
      { backlogItems: repositories.backlogItems, tasks: repositories.tasks },
      {
        listIssues: async () => listed,
        viewerLogin,
        listJiraIssues,
        broadcast: (e) => events.push(e),
      },
      repo,
    );
  }

  it("adds the first uncovered issue as a waiting item and announces it", async () => {
    const item = await run({ issues: [issue(3), issue(2)], errors: [] });
    expect(item).toMatchObject({
      repoId,
      title: "Issue 3",
      status: "waiting",
      origin: origin(3),
      freeText: "",
      dependsOn: [],
    });
    expect(repositories.backlogItems.list(repoId)).toHaveLength(1);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("skips issues covered by any task or item of the repo", async () => {
    const archived = repositories.tasks.create({
      title: "Old",
      origin: origin(1),
      repoId,
      freeText: "",
      agents: { planner: "a" },
    });
    repositories.tasks.update(archived.id, { archivedAt: new Date() });
    repositories.backlogItems.insert({
      repoId,
      title: "Paused",
      origin: { ...origin(2), url: "https://GitHub.com/ACME/App/issues/2" },
      status: "paused",
    });
    const item = await run({ issues: [issue(1), issue(2), issue(3)], errors: [] });
    expect(item?.origin).toEqual(origin(3));
  });

  it("skips issues assigned to others and takes the viewer's in list order", async () => {
    const viewerLogin = vi.fn(async () => "Me");
    const item = await run(
      {
        issues: [issue(5, { assignees: ["someone"] }), issue(4, { assignees: ["other", "me"] })],
        errors: [],
      },
      viewerLogin,
    );
    expect(item?.origin).toEqual(origin(4));
    expect(viewerLogin).toHaveBeenCalledTimes(1);
    expect(viewerLogin).toHaveBeenCalledWith("c1");
  });

  it("falls back to the issue reference for an empty title", async () => {
    const item = await run({ issues: [issue(7, { title: "  " })], errors: [] });
    expect(item?.title).toBe("acme/app#7");
  });

  it("returns undefined when no issue qualifies", async () => {
    expect(await run({ issues: [], errors: [] })).toBeUndefined();
    expect(await run({ issues: [issue(1, { assignees: ["x"] })], errors: [] })).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("rejects a listing error and adds nothing", async () => {
    await expect(
      run({ issues: [issue(1)], errors: [{ host: "github.com", message: "Bad credentials" }] }),
    ).rejects.toThrow("github.com: Bad credentials");
    expect(repositories.backlogItems.list(repoId)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("rejects when the viewer lookup fails", async () => {
    const viewerLogin = vi.fn(async (): Promise<string> => {
      throw new Error("Authenticated user: 401");
    });
    await expect(
      run({ issues: [issue(1, { assignees: ["x"] })], errors: [] }, viewerLogin),
    ).rejects.toThrow("401");
    expect(repositories.backlogItems.list(repoId)).toEqual([]);
  });

  it("takes an eligible GitHub issue without asking Jira", async () => {
    const listJiraIssues = jiraListed(jiraIssue("ABC-2"));
    const item = await run({ issues: [issue(1)], errors: [] }, undefined, listJiraIssues);
    expect(item?.origin).toEqual(origin(1));
    expect(listJiraIssues).not.toHaveBeenCalled();
  });

  it("adds the first Jira issue as a waiting item when no GitHub issue is eligible", async () => {
    const item = await run({ issues: [], errors: [] }, undefined, jiraListed(jiraIssue("ABC-2")));
    expect(item).toMatchObject({
      repoId,
      title: "Jira ABC-2",
      status: "waiting",
      origin: jiraOrigin("ABC-2"),
      freeText: "",
      dependsOn: [],
    });
    expect(repositories.backlogItems.list(repoId)).toHaveLength(1);
    expect(events).toEqual([{ type: "backlog.changed", payload: { repoId } }]);
  });

  it("falls through to Jira when every GitHub issue is covered or assigned to others", async () => {
    repositories.backlogItems.insert({
      repoId,
      title: "Paused",
      origin: origin(1),
      status: "paused",
    });
    const item = await run(
      { issues: [issue(1), issue(2, { assignees: ["someone"] })], errors: [] },
      undefined,
      jiraListed(jiraIssue("ABC-2"), jiraIssue("ABC-1")),
    );
    expect(item?.origin).toEqual(jiraOrigin("ABC-2"));
  });

  it("skips Jira issues covered by any task or item of the repo", async () => {
    const archived = repositories.tasks.create({
      title: "Old",
      origin: jiraOrigin("ABC-1"),
      repoId,
      freeText: "",
      agents: { planner: "a" },
    });
    repositories.tasks.update(archived.id, { archivedAt: new Date() });
    repositories.backlogItems.insert({
      repoId,
      title: "Paused",
      origin: { kind: "jira-issue", key: "ABC-2", connectionId: null },
      status: "paused",
    });
    const promoted = repositories.backlogItems.insert({
      repoId,
      title: "Promoted",
      origin: jiraOrigin("ABC-3"),
    });
    repositories.backlogItems.markPromoted(promoted.id, archived.id);
    const item = await run(
      { issues: [], errors: [] },
      undefined,
      jiraListed(jiraIssue("ABC-1"), jiraIssue("ABC-2"), jiraIssue("ABC-3"), jiraIssue("ABC-4")),
    );
    expect(item?.origin).toEqual(jiraOrigin("ABC-4"));
  });

  it("falls back to the Jira key for an empty title", async () => {
    const item = await run(
      { issues: [], errors: [] },
      undefined,
      jiraListed(jiraIssue("ABC-7", { title: "  " })),
    );
    expect(item?.title).toBe("ABC-7");
  });

  it("rejects a Jira listing error and adds nothing", async () => {
    const listJiraIssues = vi.fn(async (): Promise<RepoJiraIssues> => ({
      issues: [jiraIssue("ABC-1")],
      errors: [{ host: "acme.atlassian.net", message: "Unauthorized" }],
    }));
    await expect(run({ issues: [], errors: [] }, undefined, listJiraIssues)).rejects.toThrow(
      "acme.atlassian.net: Unauthorized",
    );
    expect(repositories.backlogItems.list(repoId)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("rejects a GitHub listing error without asking Jira", async () => {
    const listJiraIssues = jiraListed(jiraIssue("ABC-1"));
    await expect(
      run(
        { issues: [], errors: [{ host: "github.com", message: "Bad credentials" }] },
        undefined,
        listJiraIssues,
      ),
    ).rejects.toThrow("github.com: Bad credentials");
    expect(listJiraIssues).not.toHaveBeenCalled();
  });

  it("returns undefined when neither source has an eligible issue", async () => {
    repositories.backlogItems.insert({ repoId, title: "Paused", origin: jiraOrigin("ABC-1") });
    expect(
      await run(
        { issues: [issue(1, { assignees: ["x"] })], errors: [] },
        undefined,
        jiraListed(jiraIssue("ABC-1")),
      ),
    ).toBeUndefined();
    expect(repositories.backlogItems.list(repoId)).toHaveLength(1);
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
      ["opencode", false],
    ]);
  });
});
