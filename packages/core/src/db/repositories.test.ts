import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentSchema,
  backlogItemSchema,
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

    r.connections.delete(conn.id);
    expect(r.repos.get(repo.id)?.connectionId).toBeNull();
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

describe("agents and tags", () => {
  it("round-trips agents with JSON fields", () => {
    const agent = r.agents.create({
      name: "security",
      cli: "claude",
      eligibleStages: ["code-review"],
      permissionOverrides: { deny: ["Bash"] },
    });
    expect(r.agents.get(agent.id)).toMatchObject({
      eligibleStages: ["code-review"],
      permissionOverrides: { deny: ["Bash"] },
      model: null,
    });
    expect(r.agents.update(agent.id, { model: "opus" }).model).toBe("opus");
    expect(() => r.agents.update("missing", { model: "x" })).toThrow(/not found/);
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
    });

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
    expect(agentSchema.parse(r.agents.create({ name: "Planner", cli: "claude" }))).toBeTruthy();
    expect(
      grillQuestionSchema.parse(r.grillQuestions.create({ taskId: task.id, question: "?" })),
    ).toBeTruthy();
  });
});
