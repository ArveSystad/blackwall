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
  memorySchema,
  repoSchema,
  runSchema,
  stepEventSchema,
  stepSchema,
  taskSchema,
  type TaskCi,
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
    expect(repo.setupCommands).toEqual([]);
    expect(r.repos.update(repo.id, { setupCommands: ["pnpm i"] }).setupCommands).toEqual([
      "pnpm i",
    ]);
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

  it("watches CI on new repos by default and persists turning it off", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    expect(repo.watchCi).toBe(true);
    expect(r.repos.update(repo.id, { watchCi: false }).watchCi).toBe(false);
    expect(r.repos.get(repo.id)?.watchCi).toBe(false);
  });

  it("starts repos without a Jira project and round-trips it", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    expect(repo.jiraProject).toBeNull();
    expect(r.repos.update(repo.id, { jiraProject: "ABC" }).jiraProject).toBe("ABC");
    expect(r.repos.get(repo.id)?.jiraProject).toBe("ABC");
    expect(r.repos.update(repo.id, { jiraProject: null }).jiraProject).toBeNull();
  });

  it("starts repos without reference repos and round-trips the list", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const lib = r.repos.create({ path: "/code/lib", name: "lib" });
    expect(repo.referenceRepoIds).toEqual([]);
    expect(r.repos.update(repo.id, { referenceRepoIds: [lib.id] }).referenceRepoIds).toEqual([
      lib.id,
    ]);
    expect(r.repos.get(repo.id)?.referenceRepoIds).toEqual([lib.id]);
  });

  it("locks agents by default, round-trips the trust level and project flags", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    expect(repo).toMatchObject({
      agentTrust: "locked",
      trustProjectMcp: false,
      trustProjectHooks: false,
    });
    expect(r.repos.update(repo.id, { agentTrust: "trusted", trustProjectMcp: true })).toMatchObject(
      { agentTrust: "trusted", trustProjectMcp: true, trustProjectHooks: false },
    );
    expect(
      r.repos.update(repo.id, { trustProjectHooks: true, agentTrust: "unrestricted" }),
    ).toMatchObject({
      agentTrust: "unrestricted",
      trustProjectMcp: true,
      trustProjectHooks: true,
    });
    expect(r.repos.get(repo.id)).toMatchObject({
      agentTrust: "unrestricted",
      trustProjectMcp: true,
      trustProjectHooks: true,
    });
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
    });
    const c = r.backlogItems.insert({
      repoId: other.id,
      title: "C",
      origin: { kind: "free-text" },
    });
    expect(backlogItemSchema.parse(b)).toMatchObject({
      status: "waiting",
      triageMode: "intervene",
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

  it("round-trips the reference repos override, null by default", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const item = r.backlogItems.insert({
      repoId: repo.id,
      title: "A",
      origin: { kind: "free-text" },
    });
    expect(item.referenceRepoIds).toBeNull();
    const listed = r.backlogItems.insert({
      repoId: repo.id,
      title: "B",
      origin: { kind: "free-text" },
      referenceRepoIds: ["lib"],
    });
    expect(r.backlogItems.get(listed.id)?.referenceRepoIds).toEqual(["lib"]);

    expect(r.backlogItems.update(item.id, { referenceRepoIds: [] }).referenceRepoIds).toEqual([]);
    expect(
      r.backlogItems.update(listed.id, { referenceRepoIds: null }).referenceRepoIds,
    ).toBeNull();
    expect(r.backlogItems.get(listed.id)?.referenceRepoIds).toBeNull();
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
    expect(r.chatMessages.list(repo.id, null).map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(r.chatMessages.list(repo.id, null)[0]!.actions).toEqual([]);
    expect(r.chatMessages.latestSession(repo.id, null)).toEqual({
      sessionId: "s2",
      cli: "copilot",
    });
    expect(r.chatMessages.latestSession(other.id, null)).toBeUndefined();

    const applied = [{ ...actions[0]!, appliedAt: "2026-10-14T11:00:00.000Z" }];
    r.chatMessages.setActions("m2", applied);
    expect(r.chatMessages.list(repo.id, null)[1]!.actions).toEqual(applied);

    r.chatMessages.deleteConversation(repo.id, null);
    expect(r.chatMessages.list(repo.id, null)).toEqual([]);
    expect(r.chatMessages.list(other.id, null).map((m) => m.id)).toEqual(["o1"]);

    r.repos.delete(other.id);
    expect(r.chatMessages.list(other.id, null)).toEqual([]);
  });

  it("keeps each task's chat apart from the repo's", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const task = r.tasks.create({ title: "A", origin: { kind: "free-text" }, repoId: repo.id });
    const other = r.tasks.create({ title: "B", origin: { kind: "free-text" }, repoId: repo.id });
    const session = { role: "assistant" as const, text: "Ok", cli: "claude" as const };
    r.chatMessages.insert({ id: "r1", repoId: repo.id, ...session, sessionId: "s-repo" });
    r.chatMessages.insert({
      id: "t1",
      repoId: repo.id,
      taskId: task.id,
      ...session,
      sessionId: "s-a",
    });
    r.chatMessages.insert({
      id: "t2",
      repoId: repo.id,
      taskId: other.id,
      role: "user",
      text: "Hi",
    });

    expect(r.chatMessages.list(repo.id, null).map((m) => m.id)).toEqual(["r1"]);
    expect(r.chatMessages.list(repo.id, task.id).map((m) => m.id)).toEqual(["t1"]);
    expect(r.chatMessages.latestSession(repo.id, null)?.sessionId).toBe("s-repo");
    expect(r.chatMessages.latestSession(repo.id, task.id)?.sessionId).toBe("s-a");
    expect(r.chatMessages.latestSession(repo.id, other.id)).toBeUndefined();

    r.chatMessages.deleteConversation(repo.id, task.id);
    expect(r.chatMessages.list(repo.id, task.id)).toEqual([]);
    expect(r.chatMessages.list(repo.id, null).map((m) => m.id)).toEqual(["r1"]);
    expect(r.chatMessages.list(repo.id, other.id).map((m) => m.id)).toEqual(["t2"]);

    r.chatMessages.deleteConversation(repo.id, null);
    expect(r.chatMessages.list(repo.id, null)).toEqual([]);
    expect(r.chatMessages.list(repo.id, other.id).map((m) => m.id)).toEqual(["t2"]);

    r.tasks.delete(other.id);
    expect(r.chatMessages.list(repo.id, other.id)).toEqual([]);
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
    expect(r.agents.get(agent.id)?.efforts).toEqual({});
    expect(r.agents.update(agent.id, { efforts: { claude: "low" } }).efforts).toEqual({
      claude: "low",
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

  it("marks PR tasks' branch unchecked and leaves other origins without one", () => {
    const free = seedTask();
    const pr = r.tasks.create({
      title: "Review PR",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/app/pull/7",
        owner: "acme",
        repo: "app",
        number: 7,
        connectionId: null,
      },
      mode: "review",
      repoId: free.repoId,
    });
    expect(pr.prBranch).toBe("unchecked");
    expect(r.tasks.get(pr.id)?.prBranch).toBe("unchecked");

    expect(free.prBranch).toBeNull();
    expect(r.tasks.get(free.id)?.prBranch).toBeNull();
  });

  it("stores the PR branch state set after creation", () => {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    const pr = r.tasks.create({
      title: "Review PR",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/app/pull/7",
        owner: "acme",
        repo: "app",
        number: 7,
        connectionId: null,
      },
      mode: "review",
      repoId: repo.id,
    });
    expect(r.tasks.setPrBranch(pr.id, "owned").prBranch).toBe("owned");
    expect(r.tasks.get(pr.id)?.prBranch).toBe("owned");
    expect(r.tasks.setPrBranch(pr.id, "foreign").prBranch).toBe("foreign");
    expect(() => r.tasks.setPrBranch("missing", "owned")).toThrow(/not found/);
  });

  it("gives steps no trust until one is set, then round-trips trust and trustForced", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const step = r.steps.create({ runId: run.id, stage: "inform" });
    expect(step).toMatchObject({ trust: null, trustForced: false });

    const forced = r.steps.create({
      runId: run.id,
      stage: "implement",
      trust: "trusted",
      trustForced: true,
    });
    expect(r.steps.get(forced.id)).toMatchObject({ trust: "trusted", trustForced: true });

    expect(r.steps.update(step.id, { trust: "locked" })).toMatchObject({
      trust: "locked",
      trustForced: false,
    });
    expect(r.steps.update(step.id, { trustForced: true }).trustForced).toBe(true);
    expect(r.steps.get(step.id)).toMatchObject({ trust: "locked", trustForced: true });
  });

  it("gives steps no effort until one is set, then round-trips it", () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    const step = r.steps.create({ runId: run.id, stage: "inform" });
    expect(step.effort).toBeNull();
    expect(r.steps.update(step.id, { effort: "low" }).effort).toBe("low");
    expect(r.steps.get(step.id)?.effort).toBe("low");
    expect(r.steps.update(step.id, { effort: null }).effort).toBeNull();
  });

  it("has no CI until a watch stores it, then round-trips the JSON", () => {
    const task = seedTask();
    expect(task.ci).toBeNull();
    expect(r.tasks.get(task.id)?.ci).toBeNull();

    const ci: TaskCi = {
      state: "failed",
      sha: "abc1234def5678",
      host: "github.com",
      owner: "acme",
      repo: "app",
      checks: [
        {
          name: "unit",
          kind: "check-run",
          id: 7,
          state: "failed",
          conclusion: "failure",
          url: "https://github.com/acme/app/runs/7",
        },
        { name: "lint", kind: "status", id: 9, state: "passed", conclusion: "success", url: null },
      ],
      hint: null,
      startedAt: "2026-10-08T10:00:00.000Z",
      updatedAt: "2026-10-08T10:05:00.000Z",
      finishedAt: "2026-10-08T10:05:00.000Z",
    };
    expect(r.tasks.update(task.id, { ci }).ci).toEqual(ci);
    expect(r.tasks.get(task.id)?.ci).toEqual(ci);
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

  it("finds a step's last event of a type", () => {
    const run = r.runs.create(seedTask().id);
    const step = r.steps.create({ runId: run.id, stage: "implement" });
    r.stepEvents.append(step.id, "result", { n: 1 });
    r.stepEvents.append(step.id, "result", { n: 2 });
    r.stepEvents.append(step.id, "text", { text: "after" });

    expect(r.stepEvents.lastOfType(step.id, "result")).toMatchObject({ seq: 2, payload: { n: 2 } });
    expect(r.stepEvents.lastOfType(step.id, "missing")).toBeUndefined();
    expect(r.stepEvents.lastOfType("no-such-step", "result")).toBeUndefined();
  });

  it("lists events of the given types across steps, by step then sequence", () => {
    const run = r.runs.create(seedTask().id);
    const a = r.steps.create({ runId: run.id, stage: "implement" });
    const b = r.steps.create({ runId: run.id, stage: "implement" });
    const other = r.steps.create({ runId: run.id, stage: "implement" });
    for (const step of [b, a, other]) {
      r.stepEvents.append(step.id, "x", {});
      r.stepEvents.append(step.id, "text", {});
      r.stepEvents.append(step.id, "y", {});
    }

    const events = r.stepEvents.listOfTypes([a.id, b.id], ["x", "y"]);
    expect(events.map((e) => [e.stepId, e.seq, e.type])).toEqual(
      [a.id, b.id].sort().flatMap((id) => [
        [id, 1, "x"],
        [id, 3, "y"],
      ]),
    );
    expect(r.stepEvents.listOfTypes([], ["x"])).toEqual([]);
    expect(r.stepEvents.listOfTypes([a.id], [])).toEqual([]);
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

describe("memories", () => {
  const note = (repoId: string, text: string, extra: Record<string, unknown> = {}) =>
    r.memories.create({ repoId, kind: "convention", text, ...extra });
  const texts = (ms: { text: string }[]) => ms.map((m) => m.text);

  it("has FTS5 in the bundled SQLite", () => {
    expect(() => opened.db.$client.exec("CREATE VIRTUAL TABLE t USING fts5(x)")).not.toThrow();
  });

  it("round-trips against the shared schema and marks user edits", () => {
    const task = seedTask();
    const m = note(task.repoId, "Use pnpm", { sourceTaskId: task.id, files: ["package.json"] });
    expect(memorySchema.parse(m)).toEqual(m);
    expect(m).toMatchObject({ pinned: false, awaitingMerge: false, editedAt: null });
    expect(r.memories.update(m.id, { pinned: true }).editedAt).toBeNull();
    const edited = r.memories.update(m.id, { text: "Use pnpm 11" }, { byUser: true });
    expect(edited.editedAt).toBeInstanceOf(Date);
    expect(edited).toMatchObject({ text: "Use pnpm 11", pinned: true });
  });

  it("ranks notes matching more terms higher and keeps repos apart", () => {
    const task = seedTask();
    const other = r.repos.create({ path: "/code/other", name: "other" });
    note(task.repoId, "Unrelated note about colours");
    note(task.repoId, "The login form posts to the auth service");
    note(task.repoId, "The login page lives under routes");
    note(other.id, "The login form in another repo posts to auth");
    expect(texts(r.memories.relevant(task.repoId, "login form auth"))).toEqual([
      "The login form posts to the auth service",
      "The login page lives under routes",
    ]);
    expect(texts(r.memories.relevant(task.repoId, "login", { limit: 1 }))).toHaveLength(1);
  });

  it("puts pinned notes first and returns only them without usable terms", () => {
    const task = seedTask();
    note(task.repoId, "Pinned and unrelated", { pinned: true });
    note(task.repoId, "Pinned about login", { pinned: true });
    note(task.repoId, "Login matches strongly login");
    expect(texts(r.memories.relevant(task.repoId, "login"))).toEqual([
      "Pinned about login",
      "Pinned and unrelated",
      "Login matches strongly login",
    ]);
    for (const text of ["a an", ""]) {
      expect(texts(r.memories.relevant(task.repoId, text))).toEqual([
        "Pinned about login",
        "Pinned and unrelated",
      ]);
    }
  });

  it("never throws on FTS syntax and matches on files", () => {
    const task = seedTask();
    note(task.repoId, "Keep the parser pure", { files: ["src/parser.ts"] });
    for (const text of ['AND OR NOT ( ) * NEAR col: "x', '"""', "files:foo -bar ^baz"]) {
      expect(() => r.memories.relevant(task.repoId, text)).not.toThrow();
    }
    expect(texts(r.memories.relevant(task.repoId, "parser.ts"))).toEqual(["Keep the parser pure"]);
  });

  it("leaves out the excluded task's unedited notes but keeps its user-edited ones", () => {
    const task = seedTask();
    note(task.repoId, "Own login note", { sourceTaskId: task.id });
    const edited = note(task.repoId, "Edited login note", { sourceTaskId: task.id });
    r.memories.update(edited.id, { pinned: true }, { byUser: true });
    note(task.repoId, "Orphan login note");
    expect(texts(r.memories.relevant(task.repoId, "login", { excludeTaskId: task.id }))).toEqual([
      "Edited login note",
      "Orphan login note",
    ]);
  });

  it("replaces a task's unedited notes, keeps user edits and skips duplicates", () => {
    const task = seedTask();
    note(task.repoId, "Run codegen first");
    const first = r.memories.replaceForTask(task.id, task.repoId, [
      { kind: "pitfall", text: "Old note" },
      { kind: "pitfall", text: "Kept by the user" },
    ]);
    r.memories.update(first[1]!.id, { text: "Kept by the user" }, { byUser: true });
    const second = r.memories.replaceForTask(task.id, task.repoId, [
      { kind: "command", text: "pnpm db:generate", files: ["drizzle.config.ts"] },
      { kind: "pitfall", text: "  RUN CODEGEN FIRST " },
      { kind: "pitfall", text: "kept by the user" },
      { kind: "command", text: "PNPM db:generate" },
    ]);
    expect(texts(second)).toEqual(["pnpm db:generate"]);
    expect(second[0]).toMatchObject({ sourceTaskId: task.id, files: ["drizzle.config.ts"] });
    expect(texts(r.memories.listByRepo(task.repoId)).sort()).toEqual([
      "Kept by the user",
      "Run codegen first",
      "pnpm db:generate",
    ]);
  });

  it("holds review notes out of every read until they are released", () => {
    const task = seedTask();
    note(task.repoId, "Active login note");
    const held = r.memories.replaceForTask(
      task.id,
      task.repoId,
      [
        { kind: "convention", text: "Held login note" },
        { kind: "convention", text: "Second held login" },
      ],
      { awaitingMerge: true },
    );
    expect(held.every((m) => m.awaitingMerge)).toBe(true);
    r.memories.update(held[1]!.id, { pinned: true });
    expect(texts(r.memories.relevant(task.repoId, "login held"))).toEqual(["Active login note"]);
    expect(texts(r.memories.listByRepo(task.repoId))).toEqual(["Active login note"]);
    expect(r.memories.tasksAwaitingMerge()).toEqual([task.id]);

    // Held notes are not duplicates of each other across tasks; release dedupes.
    const other = r.tasks.create({
      title: "x",
      origin: { kind: "free-text" },
      repoId: task.repoId,
    });
    r.memories.replaceForTask(other.id, task.repoId, [
      { kind: "convention", text: "held login note" },
    ]);
    const released = r.memories.releaseForTask(task.id);
    expect(texts(released)).toEqual(["Second held login"]);
    expect(released[0]?.awaitingMerge).toBe(false);
    expect(texts(r.memories.listByRepo(task.repoId)).sort()).toEqual([
      "Active login note",
      "Second held login",
      "held login note",
    ]);
    expect(r.memories.tasksAwaitingMerge()).toEqual([]);
  });

  it("lists a repo's held notes apart, newest first", () => {
    const task = seedTask();
    const other = r.repos.create({ path: "/code/other", name: "other" });
    note(task.repoId, "Active note");
    note(task.repoId, "Older held", { awaitingMerge: true, pinned: true });
    note(task.repoId, "Newer held", { awaitingMerge: true });
    note(other.id, "Other repo held", { awaitingMerge: true });
    expect(texts(r.memories.listAwaitingByRepo(task.repoId))).toEqual(["Newer held", "Older held"]);
    expect(texts(r.memories.listByRepo(task.repoId))).toEqual(["Active note"]);
  });

  it("discards one task's held notes, or those whose task was deleted", () => {
    const task = seedTask();
    const other = r.tasks.create({
      title: "x",
      origin: { kind: "free-text" },
      repoId: task.repoId,
    });
    r.memories.replaceForTask(task.id, task.repoId, [{ kind: "context", text: "A" }], {
      awaitingMerge: true,
    });
    r.memories.replaceForTask(other.id, task.repoId, [{ kind: "context", text: "B" }], {
      awaitingMerge: true,
    });
    note(task.repoId, "Orphan held", { awaitingMerge: true });
    note(task.repoId, "Active", { sourceTaskId: task.id });
    const elsewhere = r.repos.create({ path: "/code/other", name: "other" });
    note(task.repoId, "Second orphan", { awaitingMerge: true });
    note(elsewhere.id, "Orphan elsewhere", { awaitingMerge: true });
    expect(r.memories.discardAwaiting(task.id)).toEqual([task.repoId]);
    expect(r.memories.tasksAwaitingMerge()).toEqual([other.id]);
    expect(r.memories.discardAwaiting(null).sort()).toEqual([task.repoId, elsewhere.id].sort());
    const all = opened.db.$client.prepare("SELECT text FROM memories ORDER BY text").all();
    expect(all).toEqual([{ text: "Active" }, { text: "B" }]);
    expect(r.memories.discardAwaiting(null)).toEqual([]);
    expect(r.memories.discardAwaiting(task.id)).toEqual([]);
  });

  it("finds the repo's tasks with any note, held or active", () => {
    const task = seedTask();
    const held = r.tasks.create({ title: "h", origin: { kind: "free-text" }, repoId: task.repoId });
    const bare = r.tasks.create({ title: "b", origin: { kind: "free-text" }, repoId: task.repoId });
    const repo = r.repos.create({ path: "/code/other", name: "other" });
    const elsewhere = r.tasks.create({
      title: "e",
      origin: { kind: "free-text" },
      repoId: repo.id,
    });
    note(task.repoId, "Active", { sourceTaskId: task.id });
    note(task.repoId, "Held", { sourceTaskId: held.id, awaitingMerge: true });
    note(task.repoId, "Orphan");
    note(repo.id, "Other repo", { sourceTaskId: elsewhere.id });
    const ids = r.memories.taskIdsWithNotes(task.repoId);
    expect([...ids].sort()).toEqual([task.id, held.id].sort());
    expect(ids.has(bare.id)).toBe(false);
    expect(r.memories.taskIdsWithNotes(repo.id)).toEqual(new Set([elsewhere.id]));
  });

  it("cascades with the repo and nulls the source when its task is deleted", () => {
    const task = seedTask();
    const m = note(task.repoId, "From the task", { sourceTaskId: task.id });
    r.tasks.delete(task.id);
    expect(r.memories.get(m.id)?.sourceTaskId).toBeNull();
    r.repos.delete(task.repoId);
    expect(r.memories.get(m.id)).toBeUndefined();
  });
});
