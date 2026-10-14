import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSchema,
  backlogItemSchema,
  chatMessageSchema,
  connectionSchema,
  findingSchema,
  grillQuestionSchema,
  repoSchema,
  runSchema,
  stepEventSchema,
  stepSchema,
  taskSchema,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "./database.js";
import { createRepositories, type Repositories } from "./repositories.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-repo-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedTask() {
  const repo = r.repos.create({ path: "/code/app", name: "app" });
  return r.tasks.create({ title: "Fix login", origin: { kind: "free-text" }, repoId: repo.id });
}

describe("settings", () => {
  it("upserts JSON values", () => {
    r.settings.set("roles", { planner: "a" });
    r.settings.set("roles", { planner: "b" });
    expect(r.settings.get("roles")).toEqual({ planner: "b" });
    expect(r.settings.all()).toEqual({ roles: { planner: "b" } });
    r.settings.delete("roles");
    expect(r.settings.get("roles")).toBeUndefined();
  });
});

describe("connections and repos", () => {
  it("stores connection metadata and nulls the repo link when a connection is removed", () => {
    const conn = r.connections.create({
      name: "Jira",
      kind: "jira",
      baseUrl: "https://acme.atlassian.net",
      authMeta: { email: "me@acme.test" },
    });
    expect(conn.tokenSet).toBe(false);
    expect(r.connections.update(conn.id, { tokenSet: true }).tokenSet).toBe(true);

    const repo = r.repos.create({
      path: "/code/app",
      name: "app",
      connectionId: conn.id,
      checkCommands: ["pnpm test"],
    });
    expect(r.repos.getByPath("/code/app")?.checkCommands).toEqual(["pnpm test"]);
    expect(repo.defaultCli).toBe("claude");
    expect(r.repos.update(repo.id, { defaultCli: "copilot" }).defaultCli).toBe("copilot");
    expect(repo.defaultOrigin).toBe("jira-issue");
    expect(r.repos.update(repo.id, { defaultOrigin: "free-text" }).defaultOrigin).toBe("free-text");
    expect(repo.maxBacklogTasks).toBeNull();
    expect(r.repos.update(repo.id, { maxBacklogTasks: 2 }).maxBacklogTasks).toBe(2);
    expect(repo.defaultBranch).toBe("main");
    expect(r.repos.update(repo.id, { defaultBranch: "develop" }).defaultBranch).toBe("develop");

    r.connections.delete(conn.id);
    expect(r.repos.get(repo.id)?.connectionId).toBeNull();
  });

  it("appends new repos to the manual order and lists favourites first", () => {
    const c = r.repos.create({ path: "/code/c", name: "c" });
    const a = r.repos.create({ path: "/code/a", name: "a" });
    const b = r.repos.create({ path: "/code/b", name: "b" });
    expect([c, a, b].map((repo) => [repo.favorite, repo.position])).toEqual([
      [false, 0],
      [false, 1],
      [false, 2],
    ]);
    expect(r.repos.list().map((repo) => repo.name)).toEqual(["c", "a", "b"]);

    r.repos.reorder([b.id, c.id, a.id]);
    expect(r.repos.list().map((repo) => [repo.name, repo.position])).toEqual([
      ["b", 0],
      ["c", 1],
      ["a", 2],
    ]);

    expect(r.repos.update(a.id, { favorite: true }).favorite).toBe(true);
    expect(r.repos.list().map((repo) => repo.name)).toEqual(["a", "b", "c"]);
  });

  it("orders repos with equal positions by name", () => {
    for (const name of ["c", "a", "b"])
      r.repos.create({ path: `/code/${name}`, name, position: 0 });
    expect(r.repos.list().map((repo) => repo.name)).toEqual(["a", "b", "c"]);
  });

  it("rejects duplicate repo paths", () => {
    r.repos.create({ path: "/code/app", name: "app" });
    expect(() => r.repos.create({ path: "/code/app", name: "dup" })).toThrow();
  });

  it("refuses to delete a repo that still has tasks", () => {
    const task = seedTask();
    expect(r.repos.hasTasks(task.repoId)).toBe(true);
    expect(() => r.repos.delete(task.repoId)).toThrow(/FOREIGN KEY/);
    r.tasks.delete(task.id);
    expect(r.repos.hasTasks(task.repoId)).toBe(false);
  });
});

describe("backlog items", () => {
  it("round-trips items, appends positions per repo and reorders", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const other = r.repos.create({ path: "/code/other", name: "other" });
    const a = r.backlogItems.insert({
      repoId: repo.id,
      title: "A",
      origin: { kind: "free-text" },
      freeText: "Do A",
      dependsOn: [],
    });
    const b = r.backlogItems.insert({
      repoId: repo.id,
      title: "B",
      origin: { kind: "free-text" },
      dependsOn: [a.id],
      priority: "high",
    });
    const c = r.backlogItems.insert({
      repoId: other.id,
      title: "C",
      origin: { kind: "free-text" },
    });
    expect(backlogItemSchema.parse(b)).toMatchObject({
      status: "waiting",
      triageMode: "intervene",
      priority: "high",
      dependsOn: [a.id],
      taskId: null,
    });
    expect([a.position, b.position, c.position]).toEqual([0, 1, 0]);
    expect(r.backlogItems.list(repo.id).map((i) => i.id)).toEqual([a.id, b.id]);
    expect(r.backlogItems.list()).toHaveLength(3);

    r.backlogItems.reorder(repo.id, [b.id, a.id, c.id]);
    expect(r.backlogItems.get(b.id)?.position).toBe(0);
    expect(r.backlogItems.get(a.id)?.position).toBe(1);
    // Items of another repo are left alone.
    expect(r.backlogItems.get(c.id)?.position).toBe(0);

    expect(r.backlogItems.update(a.id, { status: "paused", title: "A2" })).toMatchObject({
      status: "paused",
      title: "A2",
    });
    r.backlogItems.delete(a.id);
    expect(r.backlogItems.get(a.id)).toBeUndefined();
  });

  it("links the promoted task and unlinks it when the task goes", () => {
    const task = seedTask();
    const item = r.backlogItems.insert({
      repoId: task.repoId,
      title: "Fix login",
      origin: { kind: "free-text" },
    });
    expect(r.backlogItems.markPromoted(item.id, task.id)).toMatchObject({
      status: "promoted",
      taskId: task.id,
    });
    r.tasks.delete(task.id);
    expect(r.backlogItems.get(item.id)?.taskId).toBeNull();
  });

  it("inserts several items at the end of each repo, all or none", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const other = r.repos.create({ path: "/code/other", name: "other" });
    r.backlogItems.insert({ repoId: repo.id, title: "A", origin: { kind: "free-text" } });
    const items = r.backlogItems.insertMany([
      { repoId: repo.id, title: "B", origin: { kind: "free-text" } },
      { repoId: other.id, title: "C", origin: { kind: "free-text" } },
      { repoId: repo.id, title: "D", origin: { kind: "free-text" } },
    ]);
    expect(items.map((i) => [i.title, i.position])).toEqual([
      ["B", 1],
      ["C", 0],
      ["D", 2],
    ]);

    expect(() =>
      r.backlogItems.insertMany([
        { repoId: repo.id, title: "E", origin: { kind: "free-text" } },
        { repoId: "missing", title: "F", origin: { kind: "free-text" } },
      ]),
    ).toThrow();
    expect(r.backlogItems.list(repo.id).map((i) => i.title)).toEqual(["A", "B", "D"]);
  });

  it("links the task that proposed it and unlinks it when the task goes", () => {
    const task = seedTask();
    const item = r.backlogItems.insert({
      repoId: task.repoId,
      title: "Add tests",
      origin: { kind: "free-text" },
      sourceTaskId: task.id,
    });
    expect(backlogItemSchema.parse(item).sourceTaskId).toBe(task.id);
    r.tasks.delete(task.id);
    expect(r.backlogItems.get(item.id)?.sourceTaskId).toBeNull();
  });

  it("is removed with its repo", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const item = r.backlogItems.insert({
      repoId: repo.id,
      title: "A",
      origin: { kind: "free-text" },
    });
    r.repos.delete(repo.id);
    expect(r.backlogItems.get(item.id)).toBeUndefined();
  });
});

describe("chat messages", () => {
  it("round-trips messages in order, with actions and the latest session", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const other = r.repos.create({ path: "/code/other", name: "other" });
    const at = new Date("2026-10-14T10:00:00.000Z");
    const actions = [
      {
        id: "a1",
        kind: "create-task" as const,
        title: "Add tests",
        description: "Cover it",
        appliedAt: null,
      },
    ];
    r.chatMessages.insert({ id: "m1", repoId: repo.id, role: "user", text: "Hi", createdAt: at });
    const reply = r.chatMessages.insert({
      id: "m2",
      repoId: repo.id,
      role: "assistant",
      text: "Hello",
      actions,
      sessionId: "s1",
      cli: "claude",
      createdAt: at,
    });
    r.chatMessages.insert({
      id: "m3",
      repoId: repo.id,
      role: "assistant",
      text: "Again",
      sessionId: "s2",
      cli: "copilot",
      createdAt: at,
    });
    r.chatMessages.insert({
      id: "m4",
      repoId: repo.id,
      role: "error",
      text: "Oops",
      createdAt: at,
    });
    r.chatMessages.insert({ id: "o1", repoId: other.id, role: "user", text: "Other" });

    expect(reply).toEqual({
      id: "m2",
      role: "assistant",
      text: "Hello",
      actions,
      createdAt: "2026-10-14T10:00:00.000Z",
    });
    expect(chatMessageSchema.parse(reply)).toEqual(reply);
    expect(r.chatMessages.list(repo.id).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.chatMessages.list(repo.id)[0]!.actions).toEqual([]);
    expect(r.chatMessages.latestSession(repo.id)).toEqual({ sessionId: "s2", cli: "copilot" });
    expect(r.chatMessages.latestSession(other.id)).toBeUndefined();

    const applied = [{ ...actions[0]!, appliedAt: "2026-10-14T11:00:00.000Z" }];
    r.chatMessages.setActions("m2", applied);
    expect(r.chatMessages.list(repo.id)[1]!.actions).toEqual(applied);

    r.chatMessages.deleteForRepo(repo.id);
    expect(r.chatMessages.list(repo.id)).toEqual([]);
    expect(r.chatMessages.list(other.id).map((m) => m.id)).toEqual(["o1"]);

    r.repos.delete(other.id);
    expect(r.chatMessages.list(other.id)).toEqual([]);
  });
});

describe("agents and tags", () => {
  it("round-trips agents with JSON fields", () => {
    const agent = r.agents.create({
      name: "security",
      eligibleStages: ["code-review"],
      permissionOverrides: { claude: { deny: ["Bash"] } },
    });
    expect(r.agents.get(agent.id)).toMatchObject({
      eligibleStages: ["code-review"],
      permissionOverrides: { claude: { deny: ["Bash"] } },
      models: {},
    });
    expect(r.agents.update(agent.id, { models: { claude: "opus" } }).models).toEqual({
      claude: "opus",
    });
    expect(() => r.agents.update("missing", { models: {} })).toThrow(/not found/);
  });

  it("replaces the tag list in order", () => {
    r.tags.replace(["security", "ux"]);
    r.tags.replace(["testing", "security"]);
    expect(r.tags.names()).toEqual(["testing", "security"]);
  });
});

describe("tasks, runs and steps", () => {
  it("numbers runs per task and interrupts running steps", () => {
    const task = seedTask();
    expect(task).toMatchObject({
      status: "queued",
      stage: null,
      triageMode: "intervene",
      agents: {},
      followUps: [],
    });
    const followUps = [{ title: "Add tests", description: "Cover login", repoId: null }];
    expect(r.tasks.update(task.id, { followUps }).followUps).toEqual(followUps);
    expect(task.baseBranch).toBeNull();
    expect(r.tasks.update(task.id, { baseBranch: "feature/a" }).baseBranch).toBe("feature/a");
    expect(r.tasks.get(task.id)?.baseBranch).toBe("feature/a");

    const run1 = r.runs.create(task.id);
    const run2 = r.runs.create(task.id);
    expect([run1.number, run2.number]).toEqual([1, 2]);

    const inform = r.steps.create({ runId: run2.id, stage: "inform" });
    const plan = r.steps.create({ runId: run2.id, stage: "plan-review" });
    r.steps.update(inform.id, { status: "succeeded", sessionId: "s-1" });
    r.steps.update(plan.id, { status: "running", startedAt: new Date() });

    const interrupted = r.steps.interruptRunning();
    expect(interrupted.map((s) => s.id)).toEqual([plan.id]);
    expect(r.steps.listByRun(run2.id).map((s) => s.status)).toEqual(["succeeded", "interrupted"]);
  });

  it("lists running agent steps with their task", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const agent = r.agents.create({ name: "coder", eligibleStages: ["implement"] });
    const running = r.steps.create({
      runId: run.id,
      stage: "implement",
      agentId: agent.id,
      status: "running",
    });
    r.steps.create({ runId: run.id, stage: "checks", status: "running" });
    r.steps.create({ runId: run.id, stage: "inform", agentId: agent.id, status: "succeeded" });

    const active = r.steps.listActiveAgents();
    expect(active.map((s) => s.id)).toEqual([running.id]);
    expect(active[0]).toMatchObject({ taskId: task.id, agentId: agent.id, stage: "implement" });
  });

  it("saves a step's usage and lists agent steps that used something, with their task", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const agent = r.agents.create({ name: "coder", eligibleStages: ["implement"] });
    const used = r.steps.create({ runId: run.id, stage: "implement", agentId: agent.id });
    const startedAt = new Date("2026-10-14T10:00:00Z");
    const saved = r.steps.update(used.id, {
      startedAt,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    });
    expect(stepSchema.parse(saved)).toEqual(saved);
    const copilot = r.steps.create({ runId: run.id, stage: "code-review", agentId: agent.id });
    r.steps.update(copilot.id, { outputTokens: 7 });
    // An agent step with no usage and a harness step are left out.
    r.steps.create({ runId: run.id, stage: "implement", agentId: agent.id });
    const checks = r.steps.create({ runId: run.id, stage: "checks" });
    r.steps.update(checks.id, { outputTokens: 9 });

    expect(r.steps.usage()).toEqual([
      {
        taskId: task.id,
        stepId: used.id,
        at: startedAt,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.5,
      },
      {
        taskId: task.id,
        stepId: copilot.id,
        at: copilot.createdAt,
        inputTokens: 0,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
      },
    ]);
  });

  describe("active sub-agents", () => {
    function runningStep(startedAt: Date | null = new Date("2026-01-01T00:00:00Z")) {
      const run = r.runs.create(seedTask().id);
      const agent = r.agents.create({ name: "coder", eligibleStages: ["implement"] });
      return r.steps.create({
        runId: run.id,
        stage: "implement",
        agentId: agent.id,
        status: "running",
        startedAt,
      });
    }
    const start = (stepId: string, id: string, description: string | null = null) =>
      r.stepEvents.append(stepId, "subagent-start", {
        type: "subagent-start",
        id,
        agentType: "blackwall-worker",
        description,
      });

    it("lists none when no sub-agent started", () => {
      runningStep();
      expect(r.steps.listActiveAgents()[0]?.subagents).toEqual([]);
    });

    it("lists the open sub-agents, oldest first, without ended ones", () => {
      const step = runningStep();
      const first = start(step.id, "t1", "Run the tests");
      start(step.id, "t2");
      start(step.id, "t3");
      r.stepEvents.append(step.id, "subagent-end", { type: "subagent-end", id: "t2" });
      r.stepEvents.append(step.id, "message", { type: "message", text: "hi" });

      expect(r.steps.listActiveAgents()[0]?.subagents).toEqual([
        {
          id: "t1",
          agentType: "blackwall-worker",
          description: "Run the tests",
          startedAt: first.createdAt,
        },
        expect.objectContaining({ id: "t3", description: null }),
      ]);
    });

    it("ignores sub-agents started before the step's current attempt", () => {
      const step = runningStep(null);
      const stale = start(step.id, "t1");
      r.steps.update(step.id, { startedAt: new Date(stale.createdAt.getTime() + 1) });

      expect(r.steps.listActiveAgents()[0]?.subagents).toEqual([]);
    });
  });

  it("orders active agent steps oldest first, then by insertion", () => {
    const run = r.runs.create(seedTask().id);
    const agent = r.agents.create({ name: "rev", eligibleStages: ["code-review"] });
    const at = new Date("2026-01-01T10:00:00Z");
    const step = (createdAt: Date) =>
      r.steps.create({
        runId: run.id,
        stage: "code-review",
        agentId: agent.id,
        status: "running",
        createdAt,
      });
    const first = step(at);
    const second = step(at);
    const oldest = step(new Date("2026-01-01T09:00:00Z"));

    expect(r.steps.listActiveAgents().map((s) => s.id)).toEqual([oldest.id, first.id, second.id]);
  });

  it("lists the latest succeeded run finish time per task", () => {
    const task = seedTask();
    const other = r.tasks.create({
      title: "Other",
      origin: { kind: "free-text" },
      repoId: task.repoId,
    });
    const pending = r.tasks.create({
      title: "Pending",
      origin: { kind: "free-text" },
      repoId: task.repoId,
    });
    const early = new Date("2026-10-01T10:00:00Z");
    const late = new Date("2026-10-03T10:00:00Z");
    r.runs.setStatus(r.runs.create(task.id).id, "succeeded", early);
    r.runs.setStatus(r.runs.create(task.id).id, "succeeded", late);
    r.runs.setStatus(r.runs.create(task.id).id, "failed", new Date("2026-10-05T10:00:00Z"));
    r.runs.setStatus(r.runs.create(other.id).id, "interrupted", new Date("2026-10-05T10:00:00Z"));
    r.runs.create(other.id);
    r.runs.setStatus(r.runs.create(pending.id).id, "succeeded");

    const done = r.runs.doneTimes();
    expect(done).toEqual([{ taskId: task.id, doneAt: late }]);
    expect(done[0]?.doneAt).toBeInstanceOf(Date);
  });

  it("appends step events with increasing sequence numbers", () => {
    const run = r.runs.create(seedTask().id);
    const step = r.steps.create({ runId: run.id, stage: "implement" });

    r.stepEvents.append(step.id, "text", { text: "a" });
    r.stepEvents.append(step.id, "text", { text: "b" });
    r.stepEvents.append(step.id, "result", { ok: true });

    expect(r.stepEvents.list(step.id).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r.stepEvents.list(step.id, 2)).toMatchObject([{ seq: 3, payload: { ok: true } }]);
  });

  it("cascades task deletion to runs, steps, events, findings and questions", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const step = r.steps.create({ runId: run.id, stage: "code-review" });
    r.stepEvents.append(step.id, "text", {});
    r.findings.createMany([
      { taskId: task.id, runId: run.id, severity: "high", title: "t", explanation: "e" },
    ]);
    r.grillQuestions.create({ taskId: task.id, question: "Why?" });

    r.tasks.delete(task.id);
    const count = (table: string) =>
      opened.db.$client.prepare(`select count(*) from ${table}`).pluck().get();
    for (const table of ["runs", "steps", "step_events", "findings", "grill_questions"]) {
      expect(count(table), table).toBe(0);
    }
  });
});

describe("findings and grill questions", () => {
  it("tracks finding status", () => {
    const task = seedTask();
    const [finding] = r.findings.createMany([
      {
        taskId: task.id,
        severity: "medium",
        tags: ["security"],
        file: "src/a.ts",
        lineStart: 1,
        lineEnd: 4,
        title: "Unchecked input",
        explanation: "…",
      },
    ]);
    expect(finding).toMatchObject({ status: "open", tags: ["security"] });
    expect(r.findings.setStatus(finding!.id, "force-fix").status).toBe("force-fix");
    expect(
      r.findings.update(finding!.id, { severity: "high", tags: ["security", "data"] }),
    ).toMatchObject({
      severity: "high",
      tags: ["security", "data"],
      status: "force-fix",
      mergedIntoId: null,
    });
    expect(r.findings.createMany([])).toEqual([]);
  });

  it("deletes a finding with the duplicates merged into it", () => {
    const task = seedTask();
    const [target, duplicate, other] = r.findings.createMany(
      ["A", "A again", "B"].map((title) => ({
        taskId: task.id,
        severity: "low" as const,
        title,
        explanation: "…",
      })),
    );
    r.findings.update(duplicate!.id, { status: "merged", mergedIntoId: target!.id });

    expect(r.findings.deleteWithMerged(target!.id)).toEqual([duplicate!.id, target!.id]);
    expect(r.findings.listByTask(task.id).map((f) => f.id)).toEqual([other!.id]);
    expect(r.findings.deleteWithMerged("nope")).toEqual([]);
  });

  it("records answers to grill questions", () => {
    const task = seedTask();
    const q = r.grillQuestions.create({ taskId: task.id, question: "Which DB?", needsHuman: true });
    expect(q).toMatchObject({ answer: null, needsHuman: true });

    const answered = r.grillQuestions.answer(q.id, "SQLite", "user");
    expect(answered).toMatchObject({ answer: "SQLite", answeredBy: "user" });
    expect(answered.answeredAt).toBeInstanceOf(Date);
    expect(r.grillQuestions.listByTask(task.id)).toHaveLength(1);
  });

  it("hands a question the planner could not answer to the user", () => {
    const task = seedTask();
    const q = r.grillQuestions.create({ taskId: task.id, question: "Which locale?" });
    expect(q.needsHuman).toBe(false);
    expect(r.grillQuestions.markNeedsHuman(q.id).needsHuman).toBe(true);
    expect(r.grillQuestions.get(q.id)?.needsHuman).toBe(true);
    expect(r.grillQuestions.get("nope")).toBeUndefined();
  });
});

describe("shared schemas", () => {
  it("accept rows read back from the database", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const step = r.steps.create({ runId: run.id, stage: "inform" });
    const [finding] = r.findings.createMany([
      { taskId: task.id, severity: "low", title: "Typo", explanation: "teh" },
    ]);
    const conn = r.connections.create({
      name: "gh",
      kind: "github",
      baseUrl: "https://github.com",
    });

    expect(taskSchema.parse(task)).toEqual(task);
    expect(runSchema.parse(run)).toEqual(run);
    expect(stepSchema.parse(step)).toEqual(step);
    expect(stepEventSchema.parse(r.stepEvents.append(step.id, "text", { t: 1 }))).toBeTruthy();
    expect(findingSchema.parse(finding)).toEqual(finding);
    expect(connectionSchema.parse(conn)).toEqual(conn);
    expect(repoSchema.parse(r.repos.get(task.repoId))).toBeTruthy();
    expect(agentSchema.parse(r.agents.create({ name: "Planner" }))).toBeTruthy();
    expect(
      grillQuestionSchema.parse(r.grillQuestions.create({ taskId: task.id, question: "?" })),
    ).toBeTruthy();
  });
});
