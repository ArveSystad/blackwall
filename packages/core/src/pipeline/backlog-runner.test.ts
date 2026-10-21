import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TASK_STOPPED_ERROR,
  type AgentCli,
  type BacklogItem,
  type Task,
  type TaskStatus,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuotaTracker, type QuotaTracker } from "../agents/quota.js";
import { createAgentService, type AgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createSettingsService, type SettingsService } from "../settings/service.js";
import { createBacklogRunner, type BacklogRunnerOptions } from "./backlog-runner.js";
import { createPipelineEngine, RESUME_PROMPT } from "./engine.js";
import { createFakeAdapter } from "./fake-adapter.js";
import { createDefaultStages } from "./stages.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;
let settings: SettingsService;
let agents: AgentService;
let quota: QuotaTracker;
let now: Date;
let repoId: string;

const clock = () => now;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-runner-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
  settings = createSettingsService({ settings: r.settings, tags: r.tags });
  agents = createAgentService({
    agents: r.agents,
    settings: r.settings,
    tags: r.tags,
    repos: r.repos,
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    transaction: r.transaction,
  });
  agents.seed();
  now = new Date("2026-10-09T12:00:00Z");
  quota = createQuotaTracker({ settings: r.settings, clock });
  repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
});

afterEach(() => {
  vi.useRealTimers();
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function addItem(
  title: string,
  patch: Partial<Parameters<Repositories["backlogItems"]["insert"]>[0]> = {},
) {
  return r.backlogItems.insert({
    repoId,
    title,
    origin: { kind: "free-text" },
    freeText: `Do ${title}`,
    ...patch,
  });
}

function addTask(status: TaskStatus, repo = repoId): Task {
  return r.tasks.create({
    title: "Manual",
    origin: { kind: "free-text" },
    repoId: repo,
    freeText: "By hand",
    agents: agents.resolveRoles(),
    status,
  });
}

const item = (id: string) => r.backlogItems.get(id)!;
const setStatus = (taskId: string, status: TaskStatus) => r.tasks.update(taskId, { status });

/**
 * A runner whose promotions create `running` tasks directly, so tests move
 * them through statuses by hand.
 */
function unitRunner(overrides: Partial<BacklogRunnerOptions> = {}) {
  const promoted: BacklogItem[] = [];
  const resumed: string[] = [];
  const halts: string[] = [];
  const clis = new Map<string, AgentCli[]>();
  const runner = createBacklogRunner({
    repositories: r,
    createTask: async (backlogItem) => {
      promoted.push(backlogItem);
      const task = r.tasks.create({
        title: backlogItem.title,
        origin: backlogItem.origin,
        repoId: backlogItem.repoId,
        freeText: backlogItem.freeText,
        agents: agents.resolveRoles(backlogItem.agents),
        status: "running",
      });
      r.backlogItems.markPromoted(backlogItem.id, task.id);
      return task;
    },
    resumeTask: (taskId) => {
      resumed.push(taskId);
      setStatus(taskId, "queued");
    },
    settings,
    quota,
    clisFor: (backlogItem) => clis.get(backlogItem.title) ?? ["claude"],
    clock,
    onHalt: (_repo, taskId) => halts.push(taskId),
    log: () => undefined,
    ...overrides,
  });
  return { runner, promoted, resumed, halts, clis };
}

describe("backlog runner", () => {
  it("promotes the top item of an idle repo, and the next only after it finishes", async () => {
    const second = addItem("Second", { position: 1 });
    const first = addItem("First", { position: 0 });
    const { runner, promoted } = unitRunner();

    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["First"]);
    const firstTask = item(first.id).taskId!;

    await runner.tick();
    expect(promoted).toHaveLength(1);

    setStatus(firstTask, "done");
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["First", "Second"]);
    expect(item(second.id).status).toBe("promoted");
  });

  it("waits while a task the user started is queued, and while the repo is full", async () => {
    addItem("A");
    const manual = addTask("queued");
    const { runner, promoted } = unitRunner();

    await runner.tick();
    expect(promoted).toHaveLength(0);

    setStatus(manual.id, "running");
    settings.updateGeneral({ maxTasksPerRepo: 1 });
    await runner.tick();
    expect(promoted).toHaveLength(0);

    settings.updateGeneral({ maxTasksPerRepo: 3 });
    await runner.tick();
    expect(promoted).toHaveLength(1);
  });

  it("runs as many backlog tasks at once as the backlog limit allows", async () => {
    addItem("A");
    addItem("B");
    addItem("C");
    settings.updateGeneral({ maxBacklogTasksPerRepo: 2 });
    const { runner, promoted } = unitRunner();
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("uses the repo's own backlog limit over the global one", async () => {
    addItem("A");
    addItem("B");
    addItem("C");
    settings.updateGeneral({ maxBacklogTasksPerRepo: 1 });
    r.repos.update(repoId, { maxBacklogTasks: 2 });
    const { runner, promoted } = unitRunner();
    await runner.tick();
    await runner.tick();
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("holds to a repo's backlog limit below the global one", async () => {
    addItem("A");
    addItem("B");
    addItem("C");
    settings.updateGeneral({ maxBacklogTasksPerRepo: 3 });
    r.repos.update(repoId, { maxBacklogTasks: 1 });
    const { runner, promoted } = unitRunner();
    await runner.tick();
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["A"]);
  });

  it("leaves repos alone when the runner is off globally or for the repo", async () => {
    addItem("A");
    const { runner, promoted } = unitRunner();

    settings.updateGeneral({ backlogRunner: false });
    await runner.tick();
    expect(promoted).toHaveLength(0);

    settings.updateGeneral({ backlogRunner: true });
    settings.setRepoBacklogRunnerEnabled(repoId, false);
    await runner.tick();
    expect(promoted).toHaveLength(0);

    settings.setRepoBacklogRunnerEnabled(repoId, true);
    await runner.tick();
    expect(promoted).toHaveLength(1);
  });

  it("stops while a backlog task needs the user, unless that setting is off", async () => {
    addItem("A");
    addItem("B");
    const { runner, promoted } = unitRunner();
    await runner.tick();
    setStatus(item(promoted[0]!.id).taskId!, "needs-you");

    await runner.tick();
    expect(promoted).toHaveLength(1);

    settings.updateGeneral({ stopBacklogOnNeedsYou: false });
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("halts the repo when a backlog task fails and skips its dependants", async () => {
    const a = addItem("A");
    addItem("B", { dependsOn: [a.id] });
    const { runner, promoted, halts } = unitRunner();
    await runner.tick();
    const failed = setStatus(item(a.id).taskId!, "failed");

    runner.handleEvent({ type: "task.upserted", payload: { task: failed } });
    expect(halts).toEqual([failed.id]);
    expect(settings.repoBacklogRunner(repoId)).toMatchObject({ haltedTaskId: failed.id });

    await runner.tick();
    expect(promoted).toHaveLength(1);

    // Resumed by the user: B still waits on A, which failed.
    settings.setRepoBacklogHalt(repoId, null);
    await runner.tick();
    expect(promoted).toHaveLength(1);
  });

  it("does not halt on a failed task the user started", () => {
    const { runner, halts } = unitRunner();
    const manual = addTask("failed");
    runner.handleEvent({ type: "task.upserted", payload: { task: manual } });
    expect(halts).toEqual([]);
    expect(settings.repoBacklogRunner(repoId).haltedTaskId).toBeNull();
  });

  it("does not halt on a stopped backlog task, and moves on to the next item", async () => {
    addItem("A");
    addItem("B");
    const { runner, promoted, halts } = unitRunner({
      settings: {
        ...settings,
        general: () => ({ ...settings.general(), maxBacklogTasksPerRepo: 1 }),
      },
    });
    await runner.tick();
    const stopped = r.tasks.update(item(promoted[0]!.id).taskId!, {
      status: "interrupted",
      error: TASK_STOPPED_ERROR,
    });
    runner.handleEvent({ type: "task.upserted", payload: { task: stopped } });
    expect(halts).toEqual([]);
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["A", "B"]);
  });

  it("lifts the halt when the halting task is deleted", async () => {
    addItem("A");
    const { runner, promoted } = unitRunner();
    await runner.tick();
    const failed = setStatus(item(promoted[0]!.id).taskId!, "failed");
    runner.handleEvent({ type: "task.upserted", payload: { task: failed } });
    expect(settings.repoBacklogRunner(repoId).haltedTaskId).toBe(failed.id);

    r.tasks.delete(failed.id);
    runner.handleEvent({ type: "task.removed", payload: { taskId: failed.id } });
    expect(settings.repoBacklogRunner(repoId).haltedTaskId).toBeNull();
  });

  it("does not resume a task the user stopped after its usage limit", async () => {
    const limited = addTask("interrupted");
    quota.report("claude", { resetsAt: new Date(now.getTime() + 60_000), taskId: limited.id });
    r.tasks.update(limited.id, { error: TASK_STOPPED_ERROR });
    const { runner, resumed } = unitRunner();
    advance(60_001);
    await runner.tick();
    expect(resumed).toEqual([]);
  });

  it("skips items whose CLI is quota-paused but promotes ones on other CLIs", async () => {
    addItem("Claude work");
    addItem("Copilot work");
    const { runner, promoted, clis } = unitRunner();
    clis.set("Copilot work", ["copilot"]);
    quota.report("claude", { resetsAt: new Date(now.getTime() + 3_600_000) });

    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Copilot work"]);
    setStatus(item(promoted[0]!.id).taskId!, "done");

    await runner.tick();
    expect(promoted).toHaveLength(1);

    advance(3_600_001);
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Copilot work", "Claude work"]);
  });

  it("resumes tasks a usage limit interrupted once the quota resets, before promoting", async () => {
    addItem("A");
    const limited = addTask("interrupted");
    quota.report("claude", { resetsAt: new Date(now.getTime() + 60_000), taskId: limited.id });
    const { runner, promoted, resumed } = unitRunner();

    await runner.tick();
    expect(resumed).toEqual([]);
    expect(promoted).toHaveLength(0);

    advance(60_001);
    await runner.tick();
    expect(resumed).toEqual([limited.id]);
    // The resumed task is queued, so the backlog waits behind it.
    expect(promoted).toHaveLength(0);
  });

  it("backs off from a repo whose promotion threw", async () => {
    addItem("A");
    let attempts = 0;
    const { runner } = unitRunner({
      createTask: async () => {
        attempts++;
        throw new Error("repo folder is gone");
      },
    });
    await runner.tick();
    await runner.tick();
    expect(attempts).toBe(1);
    advance(5 * 60_000 + 1);
    await runner.tick();
    expect(attempts).toBe(2);
  });

  it("ticks on its interval and after events, and stops", async () => {
    vi.useFakeTimers();
    addItem("A");
    addItem("B");
    const { runner, promoted } = unitRunner({ intervalMs: 1000 });
    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(promoted).toHaveLength(1);

    const done = setStatus(item(promoted[0]!.id).taskId!, "done");
    runner.handleEvent({ type: "task.upserted", payload: { task: done } });
    await vi.advanceTimersByTimeAsync(0);
    expect(promoted).toHaveLength(2);

    await runner.stop();
    setStatus(item(promoted[1]!.id).taskId!, "done");
    addItem("C");
    await vi.advanceTimersByTimeAsync(5000);
    expect(promoted).toHaveLength(2);
  });
});

describe("backlog runner with remote issues", () => {
  const refreshMs = () => settings.general().githubIssuesRefreshSeconds * 1000;

  /** An importer that adds one GitHub or Jira issue item per call, numbered from 1. */
  function importer(
    result: () => "item" | "jira" | "none" | "throw" = () => "item",
    failure = "github.com: Bad credentials",
  ) {
    let calls = 0;
    const importRemoteIssue = vi.fn(async () => {
      calls++;
      const outcome = result();
      if (outcome === "throw") throw new Error(failure);
      if (outcome === "none") return undefined;
      if (outcome === "jira") {
        return addItem(`Jira ${calls}`, {
          origin: { kind: "jira-issue", key: `ABC-${calls}`, connectionId: null },
          freeText: "",
        });
      }
      return addItem(`Issue ${calls}`, {
        origin: {
          kind: "github-issue",
          url: `https://github.com/acme/app/issues/${calls}`,
          owner: "acme",
          repo: "app",
          number: calls,
          connectionId: null,
        },
        freeText: "",
      });
    });
    return importRemoteIssue;
  }

  beforeEach(() => {
    settings.setRepoBacklogIncludeRemoteIssues(repoId, true);
  });

  it("imports and promotes an issue when the queue is empty", async () => {
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    expect(promoted.map((i) => i.title)).toEqual(["Issue 1"]);
    expect(item(promoted[0]!.id).status).toBe("promoted");

    // Running: the repo is not idle while the backlog limit is reached.
    settings.updateGeneral({ maxBacklogTasksPerRepo: 1 });
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);

    // Done: the next issue is imported right away, no cooldown.
    setStatus(item(promoted[0]!.id).taskId!, "done");
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Issue 1", "Issue 2"]);
  });

  it("does not import when the switch is off or the port is missing", async () => {
    settings.setRepoBacklogIncludeRemoteIssues(repoId, false);
    const importRemoteIssue = importer();
    await unitRunner({ importRemoteIssue }).runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();

    settings.setRepoBacklogIncludeRemoteIssues(repoId, true);
    const { runner, promoted } = unitRunner();
    await runner.tick();
    expect(promoted).toHaveLength(0);
  });

  it("does not import while the repo is not idle or halted", async () => {
    const importRemoteIssue = importer();
    const { runner } = unitRunner({ importRemoteIssue });

    const manual = addTask("queued");
    await runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();
    r.tasks.delete(manual.id);

    settings.setRepoBacklogHalt(repoId, manual.id);
    await runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();
    settings.setRepoBacklogHalt(repoId, null);

    settings.setRepoBacklogRunnerEnabled(repoId, false);
    await runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();
  });

  it("does not import while a backlog task needs the user or the backlog is full", async () => {
    addItem("Local");
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    settings.updateGeneral({ maxBacklogTasksPerRepo: 1 });
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Local"]);
    await runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();

    setStatus(item(promoted[0]!.id).taskId!, "needs-you");
    await runner.tick();
    expect(importRemoteIssue).not.toHaveBeenCalled();
  });

  it("starts local items before importing", async () => {
    addItem("Local");
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Local"]);
    expect(importRemoteIssue).not.toHaveBeenCalled();
  });

  it("imports when the queue holds only paused or blocked items", async () => {
    addItem("Paused", { status: "paused" });
    const running = addItem("Running");
    addItem("Blocked", { dependsOn: [running.id] });
    settings.updateGeneral({ maxBacklogTasksPerRepo: 2 });
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Running"]);
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Running", "Issue 1"]);
  });

  it("waits out the cooldown after an empty result", async () => {
    const importRemoteIssue = importer(() => "none");
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    advance(refreshMs() + 1);
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(2);
    expect(promoted).toHaveLength(0);
  });

  it("logs a failed import and waits out the cooldown", async () => {
    const logs: string[] = [];
    const importRemoteIssue = importer(() => "throw");
    const { runner } = unitRunner({ importRemoteIssue, log: (m) => logs.push(m) });
    await runner.tick();
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([expect.stringContaining("github.com: Bad credentials")]);
    advance(refreshMs() + 1);
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(2);
  });

  it("promotes a Jira import in the same pass, like a GitHub one", async () => {
    const importRemoteIssue = importer(() => "jira");
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    expect(promoted.map((i) => i.title)).toEqual(["Jira 1"]);
    expect(item(promoted[0]!.id).status).toBe("promoted");
  });

  it("shares one import and one cooldown across GitHub and Jira", async () => {
    const outcomes = ["item", "jira"] as const;
    let pass = 0;
    const importRemoteIssue = importer(() => outcomes[pass++] ?? "none");
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    setStatus(item(promoted[0]!.id).taskId!, "done");
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(2);
    expect(promoted.map((i) => i.title)).toEqual(["Issue 1", "Jira 2"]);

    setStatus(item(promoted[1]!.id).taskId!, "done");
    await runner.tick();
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(3);
    advance(refreshMs() + 1);
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(4);
    expect(promoted).toHaveLength(2);
  });

  it("logs a failed Jira import and waits out the cooldown", async () => {
    const logs: string[] = [];
    const importRemoteIssue = importer(() => "throw", "acme.atlassian.net: Unauthorized");
    const { runner } = unitRunner({ importRemoteIssue, log: (m) => logs.push(m) });
    await runner.tick();
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([expect.stringContaining("acme.atlassian.net: Unauthorized")]);
    advance(refreshMs() + 1);
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(2);
  });

  it("imports at most one issue while its CLI is quota-paused", async () => {
    const resetsAt = new Date(now.getTime() + 10 * refreshMs());
    quota.report("claude", { resetsAt });
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });

    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
    expect(promoted).toHaveLength(0);
    expect(r.backlogItems.list(repoId).map((i) => i.status)).toEqual(["waiting"]);

    // Cooldown.
    await runner.tick();
    // Past the cooldown, the imported item is held by the quota pause.
    advance(refreshMs() + 1);
    await runner.tick();
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);

    advance(resetsAt.getTime() - now.getTime() + 1);
    await runner.tick();
    expect(promoted.map((i) => i.title)).toEqual(["Issue 1"]);
    expect(importRemoteIssue).toHaveBeenCalledTimes(1);
  });

  it("does not import while a local item is held by a quota pause", async () => {
    addItem("Claude work");
    quota.report("claude", { resetsAt: new Date(now.getTime() + 3_600_000) });
    const importRemoteIssue = importer();
    const { runner, promoted } = unitRunner({ importRemoteIssue });
    await runner.tick();
    expect(promoted).toHaveLength(0);
    expect(importRemoteIssue).not.toHaveBeenCalled();
  });
});

describe("backlog runner with the pipeline engine", () => {
  it("waits out a Claude usage limit: pauses promotion, resumes the interrupted task, moves on", async () => {
    const resetsAt = new Date(now.getTime() + 3_600_000);
    let limit = true;
    const script = (options: { prompt: string }) =>
      limit && options.prompt !== RESUME_PROMPT
        ? { sessionId: "planner-1", rateLimit: { resetsAt: resetsAt.toISOString() } }
        : {};
    // The planner runs on Claude Code (the repo's CLI), the plan reviewer on Copilot.
    const agentClis = Object.fromEntries(
      (agents.roleDefaults().planReviewers ?? []).map((id) => [id, "copilot" as const]),
    );
    const engine = createPipelineEngine({
      repositories: r,
      invocation: agents.invocation,
      adapters: {
        claude: createFakeAdapter("claude", script),
        copilot: createFakeAdapter("copilot", () => ({ structured: { questions: [] } })),
      },
      stages: createDefaultStages(),
      prepareWorkspace: async (task) => ({ branch: `agent/${task.id}`, worktreePath: dir }),
      delivery: {
        plan: async () => ({ actions: [], squash: null, completed: [] }),
        deliver: async () => undefined,
      },
      maxTasksPerRepo: settings.maxTasksPerRepo,
      quota,
      log: () => undefined,
    });
    const runner = createBacklogRunner({
      repositories: r,
      createTask: async (backlogItem) => {
        const { title, origin, mode, repoId: repo, freeText, triageMode } = backlogItem;
        const task = engine.createTask({
          title,
          origin,
          mode,
          repoId: repo,
          freeText,
          triageMode,
          agents: agents.resolveRoles(backlogItem.agents),
          cli: "claude",
          agentClis: backlogItem.agentClis,
        });
        r.backlogItems.markPromoted(backlogItem.id, task.id);
        return task;
      },
      resumeTask: (taskId) => void engine.resume(taskId),
      settings,
      quota,
      clisFor: (backlogItem) =>
        agents.clisFor(agents.resolveRoles(backlogItem.agents), backlogItem.agentClis, "claude"),
      clock,
      log: () => undefined,
    });
    const a = addItem("A", { agentClis });
    const b = addItem("B", { agentClis });

    await runner.tick();
    await engine.idle();
    const first = item(a.id).taskId!;
    expect(r.tasks.get(first)).toMatchObject({ status: "interrupted" });
    expect(quota.pausedUntil("claude")).toEqual(resetsAt);

    // Claude is paused: B (whose planner runs on Claude) waits.
    await runner.tick();
    expect(item(b.id).status).toBe("waiting");

    // The quota resets: A resumes its session first, B still waits behind it.
    limit = false;
    advance(3_600_001);
    await runner.tick();
    expect(item(b.id).status).toBe("waiting");
    await engine.idle();
    expect(r.tasks.get(first)).toMatchObject({ status: "needs-you", gate: "plan-approval" });

    // A waits on the user; with "stop when a task needs me" off the runner moves on.
    await runner.tick();
    expect(item(b.id).status).toBe("waiting");
    settings.updateGeneral({ stopBacklogOnNeedsYou: false });
    await runner.tick();
    expect(item(b.id).status).toBe("promoted");
    await engine.shutdown();
  });
});
