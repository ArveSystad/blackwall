import {
  FindingNotFoundError,
  MissingCredentialError,
  TaskNotFoundError,
  TaskStateError,
  createRepositories,
  openDatabase,
  resolveClis,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  activeAgentStepSchema,
  branchDiffSchema,
  deliveryPlanSchema,
  diffCommentsResultSchema,
  findingDeleteResultSchema,
  findingSchema,
  grillAnswerResultSchema,
  grillQuestionSchema,
  runSchema,
  stepEventSchema,
  stepSchema,
  taskArtifactSchema,
  taskDiffSchema,
  taskDoneTimeSchema,
  taskSchema,
  type BranchDiff,
  type DiffCommentsResult,
  type GateResponseInput,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import { fallbackTitle, type TaskPipeline } from "./tasks.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

let opened: OpenedDatabase;
let repositories: Repositories;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  app = createApp({ token: launchToken, getPort: () => port, tasks: stores() }).app;
});

afterEach(() => opened.close());

const stores = () => ({
  tasks: repositories.tasks,
  grillQuestions: repositories.grillQuestions,
  findings: repositories.findings,
  runs: repositories.runs,
  steps: repositories.steps,
  stepEvents: repositories.stepEvents,
});

function seedFinding(taskId: string) {
  const [finding] = repositories.findings.createMany([
    {
      taskId,
      severity: "high",
      tags: ["security"],
      file: "src/auth.ts",
      lineStart: 3,
      lineEnd: 3,
      title: "Token logged",
      explanation: "The token is written to stdout.",
    },
  ]);
  return finding!;
}

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, cookie, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

function seedTask() {
  const repo = repositories.repos.create({ path: "/code/app", name: "app" });
  return repositories.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
  });
}

describe("task routes", () => {
  it("lists tasks and gets one by id", async () => {
    const repo = repositories.repos.create({ path: "/code/app", name: "app" });
    const task = repositories.tasks.create({
      title: "Fix login",
      origin: { kind: "free-text" },
      repoId: repo.id,
    });

    const list = taskSchema.array().parse(await (await request("/api/tasks")).json());
    expect(list.map((t) => t.id)).toEqual([task.id]);

    const one = taskSchema.parse(await (await request(`/api/tasks/${task.id}`)).json());
    expect(one).toMatchObject({ id: task.id, title: "Fix login", status: "queued" });
  });

  it("lists a task's grill questions", async () => {
    const task = seedTask();
    const q = repositories.grillQuestions.create({
      taskId: task.id,
      question: "Which locale?",
      needsHuman: true,
    });
    const res = await request(`/api/tasks/${task.id}/questions`);
    expect(res.status).toBe(200);
    const list = grillQuestionSchema.array().parse(await res.json());
    expect(list.map((x) => [x.id, x.needsHuman, x.answer])).toEqual([[q.id, true, null]]);
    expect((await request("/api/tasks/nope/questions")).status).toBe(404);
  });

  it("lists a task's findings", async () => {
    const task = seedTask();
    const finding = seedFinding(task.id);
    const res = await request(`/api/tasks/${task.id}/findings`);
    expect(res.status).toBe(200);
    const list = findingSchema.array().parse(await res.json());
    expect(list.map((f) => [f.id, f.status, f.mergedIntoId])).toEqual([[finding.id, "open", null]]);
    expect((await request("/api/tasks/nope/findings")).status).toBe(404);
  });

  it("lists a task's runs, a run's steps and a step's events", async () => {
    const task = seedTask();
    const run = repositories.runs.create(task.id);
    const step = repositories.steps.create({
      runId: run.id,
      stage: "checks",
      agentId: null,
      round: 0,
      visit: 0,
      status: "succeeded",
    });
    repositories.stepEvents.append(step.id, "check.started", { command: "pnpm test" });

    const runs = runSchema
      .array()
      .parse(await (await request(`/api/tasks/${task.id}/runs`)).json());
    expect(runs.map((r) => r.id)).toEqual([run.id]);
    const steps = stepSchema
      .array()
      .parse(await (await request(`/api/tasks/${task.id}/runs/${run.id}/steps`)).json());
    expect(steps.map((s) => s.id)).toEqual([step.id]);
    const events = stepEventSchema
      .array()
      .parse(await (await request(`/api/tasks/${task.id}/steps/${step.id}/events`)).json());
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ["check.started", { command: "pnpm test" }],
    ]);

    expect((await request(`/api/tasks/nope/runs`)).status).toBe(404);
    expect((await request(`/api/tasks/nope/runs/${run.id}/steps`)).status).toBe(404);
    expect((await request(`/api/tasks/nope/steps/${step.id}/events`)).status).toBe(404);
  });

  it("lists the running agent steps with their task", async () => {
    const task = seedTask();
    const run = repositories.runs.create(task.id);
    const agent = repositories.agents.create({
      name: "coder",
      eligibleStages: ["implement"],
    });
    const step = repositories.steps.create({
      runId: run.id,
      stage: "implement",
      agentId: agent.id,
      status: "running",
    });
    repositories.stepEvents.append(step.id, "subagent-start", {
      type: "subagent-start",
      id: "t1",
      agentType: "blackwall-worker",
      description: "Run the tests",
    });

    const res = await request("/api/tasks/active-agents");
    expect(res.status).toBe(200);
    const active = activeAgentStepSchema.array().parse(await res.json());
    expect(active.map((s) => [s.id, s.taskId])).toEqual([[step.id, task.id]]);
    expect(active[0]?.subagents).toEqual([
      expect.objectContaining({
        id: "t1",
        agentType: "blackwall-worker",
        description: "Run the tests",
      }),
    ]);
    expect(active[0]?.subagents[0]?.startedAt).toBeInstanceOf(Date);
  });

  it("lists when each done task was resolved", async () => {
    const done = seedTask();
    repositories.tasks.update(done.id, { status: "done" });
    const doneAt = new Date("2026-10-08T12:00:00Z");
    repositories.runs.setStatus(repositories.runs.create(done.id).id, "succeeded", doneAt);
    const running = repositories.tasks.create({
      title: "Still going",
      origin: { kind: "free-text" },
      repoId: done.repoId,
      status: "running",
    });
    repositories.runs.create(running.id);

    const res = await request("/api/tasks/done-times");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ taskId: done.id, doneAt: doneAt.toISOString() }]);
    expect(taskDoneTimeSchema.array().parse(body)).toEqual([{ taskId: done.id, doneAt }]);
  });

  it("returns 404 for an unknown task", async () => {
    const res = await request("/api/tasks/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Task nope not found" });
  });
});

describe("pipeline task routes", () => {
  let pipeline: TaskPipeline;

  beforeEach(() => {
    pipeline = {
      createTask: vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" })),
      resume: vi.fn((id: string) => repositories.tasks.update(id, { status: "queued" })),
      archive: vi.fn((id: string) => {
        const task = repositories.tasks.get(id);
        if (!task) throw new TaskNotFoundError(id);
        if (task.status !== "done") throw new TaskStateError(`Task ${id} is ${task.status}`);
        return repositories.tasks.update(id, { archivedAt: new Date() });
      }),
      unarchive: vi.fn((id: string) => repositories.tasks.update(id, { archivedAt: null })),
      stop: vi.fn(async (id: string) =>
        repositories.tasks.update(id, { status: "interrupted", error: "Stopped by you" }),
      ),
      delete: vi.fn(async (id: string) => {
        const task = repositories.tasks.get(id);
        if (!task) throw new TaskNotFoundError(id);
        if (task.deliveryTargets.length > 0) throw new TaskStateError("already delivered");
        repositories.tasks.delete(id);
      }),
      answerQuestion: vi.fn(async (id: string, questionId: string, input: { answer: string }) => ({
        question: repositories.grillQuestions.answer(questionId, input.answer, "user"),
        task: repositories.tasks.update(id, { status: "queued", gate: null }),
      })),
      overrideFinding: vi.fn(
        (id: string, findingId: string, input: { status: "force-fix" | "force-ignore" }) => {
          if (!repositories.findings.get(findingId)) throw new FindingNotFoundError(findingId);
          return repositories.findings.setStatus(findingId, input.status);
        },
      ),
      respond: vi.fn(async (id: string, input: GateResponseInput) => {
        if (input.gate === "finish" && input.delivery) {
          return repositories.tasks.update(id, { status: "done", gate: null });
        }
        if (input.gate !== "plan-approval")
          throw new TaskStateError(`Task ${id} is not waiting on ${input.gate}`);
        return repositories.tasks.update(id, { status: "queued", gate: null, stage: "implement" });
      }),
      deliveryPlan: vi.fn(async () => ({
        actions: [{ kind: "merge-main" as const, branch: "agent/t1", into: "main" }],
        squash: null,
        completed: [],
      })),
      commentOnDiff: vi.fn((id: string): DiffCommentsResult => ({
        findings: [],
        task: repositories.tasks.get(id)!,
      })),
      deleteFinding: vi.fn((_id: string, findingId: string) => {
        if (!repositories.findings.get(findingId)) throw new FindingNotFoundError(findingId);
        return { deletedIds: [findingId] };
      }),
    };
    app = createApp({
      token: launchToken,
      getPort: () => port,
      tasks: stores(),
      pipeline,
    }).app;
  });

  it("resumes a task", async () => {
    const task = seedTask();
    repositories.tasks.update(task.id, { status: "interrupted" });
    const res = await request(`/api/tasks/${task.id}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json()).status).toBe("queued");
    expect(pipeline.resume).toHaveBeenCalledWith(task.id);
  });

  it("archives a done task: 200, 409 unless done, 404 when unknown", async () => {
    const task = seedTask();
    repositories.tasks.update(task.id, { status: "done" });
    const res = await request(`/api/tasks/${task.id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json()).archivedAt).toBeInstanceOf(Date);
    expect(pipeline.archive).toHaveBeenCalledWith(task.id);

    const failed = repositories.tasks.create({
      title: "Other",
      origin: { kind: "free-text" },
      repoId: task.repoId,
      status: "failed",
    });
    const refused = await request(`/api/tasks/${failed.id}/archive`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: `Task ${failed.id} is failed` });
    expect(repositories.tasks.get(failed.id)?.archivedAt).toBeNull();

    expect((await request("/api/tasks/nope/archive", { method: "POST" })).status).toBe(404);
  });

  it("unarchives a task", async () => {
    const task = seedTask();
    repositories.tasks.update(task.id, { status: "done", archivedAt: new Date() });
    const res = await request(`/api/tasks/${task.id}/unarchive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json()).archivedAt).toBeNull();
    expect(pipeline.unarchive).toHaveBeenCalledWith(task.id);
  });

  it("stops a task", async () => {
    const task = seedTask();
    repositories.tasks.update(task.id, { status: "running" });
    const res = await request(`/api/tasks/${task.id}/stop`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(taskSchema.parse(await res.json())).toMatchObject({
      status: "interrupted",
      error: "Stopped by you",
    });
    expect(pipeline.stop).toHaveBeenCalledWith(task.id);
  });

  it("deletes a task: 204, 409 once delivered, 404 when unknown", async () => {
    const delivered = seedTask();
    const task = repositories.tasks.create({
      title: "Other",
      origin: { kind: "free-text" },
      repoId: delivered.repoId,
      freeText: "",
      agents: {},
    });
    const res = await request(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(repositories.tasks.get(task.id)).toBeUndefined();

    repositories.tasks.update(delivered.id, { status: "done", deliveryTargets: ["push-branch"] });
    const refused = await request(`/api/tasks/${delivered.id}`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(repositories.tasks.get(delivered.id)).toBeDefined();

    expect((await request("/api/tasks/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("answers a gate, rejecting bad bodies and the wrong gate", async () => {
    const task = seedTask();
    const ok = await request(`/api/tasks/${task.id}/gate`, {
      method: "POST",
      body: { gate: "plan-approval", decision: "approve" },
    });
    expect(ok.status).toBe(200);
    expect(taskSchema.parse(await ok.json()).stage).toBe("implement");

    const bad = await request(`/api/tasks/${task.id}/gate`, {
      method: "POST",
      body: { gate: "plan-approval", decision: "maybe" },
    });
    expect(bad.status).toBe(400);

    const wrong = await request(`/api/tasks/${task.id}/gate`, {
      method: "POST",
      body: { gate: "finish", decision: "approve" },
    });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ error: `Task ${task.id} is not waiting on finish` });
  });

  it("shows the delivery plan and passes the confirmed actions on", async () => {
    const task = seedTask();
    const plan = await request(`/api/tasks/${task.id}/delivery`);
    expect(plan.status).toBe(200);
    expect(deliveryPlanSchema.parse(await plan.json()).actions).toEqual([
      { kind: "merge-main", branch: "agent/t1", into: "main" },
    ]);

    const done = await request(`/api/tasks/${task.id}/gate`, {
      method: "POST",
      body: {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["merge-main", "create-tasks"], followUpIndexes: [0, 2] },
      },
    });
    expect(done.status).toBe(200);
    expect(pipeline.respond).toHaveBeenCalledWith(task.id, {
      gate: "finish",
      decision: "approve",
      delivery: {
        actions: ["merge-main", "create-tasks"],
        squash: false,
        findingIds: [],
        followUpIndexes: [0, 2],
      },
    });

    const unknown = await request(`/api/tasks/${task.id}/gate`, {
      method: "POST",
      body: { gate: "finish", decision: "approve", delivery: { actions: ["push-main"] } },
    });
    expect(unknown.status).toBe(400);
  });

  it("answers a grill question, rejecting blank answers", async () => {
    const task = seedTask();
    const q = repositories.grillQuestions.create({
      taskId: task.id,
      question: "Which locale?",
      needsHuman: true,
    });
    const ok = await request(`/api/tasks/${task.id}/questions/${q.id}/answer`, {
      method: "POST",
      body: { answer: " nb-NO " },
    });
    expect(ok.status).toBe(200);
    const result = grillAnswerResultSchema.parse(await ok.json());
    expect(result.question).toMatchObject({ answer: "nb-NO", answeredBy: "user" });
    expect(result.task.status).toBe("queued");
    expect(pipeline.answerQuestion).toHaveBeenCalledWith(task.id, q.id, { answer: "nb-NO" });

    const blank = await request(`/api/tasks/${task.id}/questions/${q.id}/answer`, {
      method: "POST",
      body: { answer: "  " },
    });
    expect(blank.status).toBe(400);
  });

  it("force-fixes or force-ignores a finding, rejecting other statuses", async () => {
    const task = seedTask();
    const finding = seedFinding(task.id);
    const ok = await request(`/api/tasks/${task.id}/findings/${finding.id}`, {
      method: "POST",
      body: { status: "force-ignore" },
    });
    expect(ok.status).toBe(200);
    expect(findingSchema.parse(await ok.json()).status).toBe("force-ignore");
    expect(pipeline.overrideFinding).toHaveBeenCalledWith(task.id, finding.id, {
      status: "force-ignore",
    });

    const bad = await request(`/api/tasks/${task.id}/findings/${finding.id}`, {
      method: "POST",
      body: { status: "fixed" },
    });
    expect(bad.status).toBe(400);

    const missing = await request(`/api/tasks/${task.id}/findings/nope`, {
      method: "POST",
      body: { status: "force-fix" },
    });
    expect(missing.status).toBe(404);
  });

  it("deletes a finding: 200 with the deleted ids, 404 when unknown, 409 off review triage", async () => {
    const task = seedTask();
    const finding = seedFinding(task.id);
    const path = `/api/tasks/${task.id}/findings/${finding.id}`;
    const ok = await request(path, { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(findingDeleteResultSchema.parse(await ok.json())).toEqual({
      deletedIds: [finding.id],
    });
    expect(pipeline.deleteFinding).toHaveBeenCalledWith(task.id, finding.id);

    const missing = await request(`/api/tasks/${task.id}/findings/nope`, { method: "DELETE" });
    expect(missing.status).toBe(404);

    vi.mocked(pipeline.deleteFinding).mockImplementationOnce(() => {
      throw new TaskStateError(`Task ${task.id} is not waiting at review triage`);
    });
    const refused = await request(path, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: expect.any(String) });
  });

  it("comments on the branch diff, rejecting empty or blank comments", async () => {
    const task = seedTask();
    const comment = {
      file: "src/auth.ts",
      lineStart: 3,
      lineEnd: 4,
      hunk: "@@ -1,2 +3,4 @@\n+const x = 1;",
      body: "Rename this.",
    };
    const ok = await request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      body: { comments: [comment] },
    });
    expect(ok.status).toBe(200);
    expect(diffCommentsResultSchema.parse(await ok.json())).toMatchObject({
      findings: [],
      task: { id: task.id },
    });
    expect(pipeline.commentOnDiff).toHaveBeenCalledWith(task.id, { comments: [comment] });

    const empty = await request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      body: { comments: [] },
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: expect.any(String) });

    const blank = await request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      body: { comments: [{ ...comment, body: "  " }] },
    });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: expect.any(String) });

    // Only the valid request reached the pipeline.
    expect(pipeline.commentOnDiff).toHaveBeenCalledTimes(1);
  });
});

describe("new tasks", () => {
  let pipeline: TaskPipeline;
  let originTitle: ReturnType<typeof vi.fn<(origin: unknown) => Promise<string | undefined>>>;
  let branchDiff: ReturnType<typeof vi.fn<(task: { id: string }) => Promise<BranchDiff | null>>>;
  let repoId: string;

  beforeEach(() => {
    repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
    pipeline = {
      createTask: vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" })),
      resume: vi.fn(),
      archive: vi.fn(),
      unarchive: vi.fn(),
      stop: vi.fn(),
      delete: vi.fn(),
      respond: vi.fn(),
      answerQuestion: vi.fn(),
      overrideFinding: vi.fn(),
      deliveryPlan: vi.fn(),
      commentOnDiff: vi.fn(),
      deleteFinding: vi.fn(),
    };
    originTitle = vi.fn(async () => "Persist wizard progress");
    branchDiff = vi.fn(async (task: { id: string }): Promise<BranchDiff | null> => ({
      from: "abc",
      to: "def",
      diff: `branch diff for ${task.id}`,
    }));
    app = createApp({
      token: launchToken,
      getPort: () => port,
      tasks: stores(),
      pipeline,
      taskServices: {
        newTask: {
          repos: { use: (id) => repositories.repos.get(id)! },
          resolveRoles: (overrides = {}) => ({ planner: "a-default", ...overrides }),
          resolveClis,
          originTitle,
        },
        diffs: async (task) => [
          { round: 0, from: "abc", to: "def", reviewed: true, diff: `diff for ${task.id}` },
        ],
        branchDiff,
        artifacts: {
          list: async () => [
            { path: "ui/home.png", size: 3, modifiedAt: new Date("2026-01-02T03:04:05Z") },
          ],
          read: async (_task, path) =>
            path === "ui/home.png"
              ? { body: Buffer.from([1, 2, 3]), contentType: "image/png" }
              : null,
        },
      },
    }).app;
  });

  const prOrigin = {
    kind: "github-pr",
    url: "https://github.com/acme/web/pull/914",
    owner: "acme",
    repo: "web",
    number: 914,
    connectionId: null,
  } as const;

  it("creates a PR task titled from the PR, with the role defaults under the form's agents", async () => {
    const res = await request("/api/tasks", {
      method: "POST",
      body: { origin: prOrigin, mode: "work", repoId, agents: { implementer: "a-impl" } },
    });
    expect(res.status).toBe(201);
    const task = taskSchema.parse(await res.json());
    expect(task).toMatchObject({
      title: "Persist wizard progress",
      mode: "work",
      status: "queued",
      agents: { planner: "a-default", implementer: "a-impl" },
      triageMode: "intervene",
    });
    expect(originTitle).toHaveBeenCalledWith(prOrigin);
  });

  it("runs a task on its repo's CLI, keeping only the form's real CLI overrides", async () => {
    const copilotRepo = repositories.repos.create({
      path: "/code/ghe",
      name: "ghe",
      defaultCli: "copilot",
    });
    const res = await request("/api/tasks", {
      method: "POST",
      body: {
        origin: prOrigin,
        mode: "work",
        repoId: copilotRepo.id,
        agents: { implementer: "a-impl" },
        // a-default matches the repo's CLI, and a-gone is in no role.
        agentClis: { "a-impl": "claude", "a-default": "copilot", "a-gone": "claude" },
      },
    });
    expect(res.status).toBe(201);
    expect(taskSchema.parse(await res.json())).toMatchObject({
      agents: { planner: "a-default", implementer: "a-impl" },
      cli: "copilot",
      agentClis: { "a-impl": "claude" },
    });

    const plain = await request("/api/tasks", {
      method: "POST",
      body: { origin: prOrigin, mode: "work", repoId },
    });
    expect(taskSchema.parse(await plain.json())).toMatchObject({ cli: "claude", agentClis: {} });
  });

  it("titles a free text task from its first line and validates the form", async () => {
    const res = await request("/api/tasks", {
      method: "POST",
      body: { origin: { kind: "free-text" }, repoId, freeText: "Add dark mode\nUse tokens." },
    });
    expect(taskSchema.parse(await res.json()).title).toBe("Add dark mode");
    expect(originTitle).not.toHaveBeenCalled();

    const blank = await request("/api/tasks", {
      method: "POST",
      body: { origin: { kind: "free-text" }, repoId, freeText: " " },
    });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "Describe the task" });
  });

  it("falls back to the origin key when the title lookup fails, but surfaces a missing token", async () => {
    originTitle.mockRejectedValueOnce(new Error("network down"));
    const jira = { kind: "jira-issue", key: "ABC-12", connectionId: null };
    const res = await request("/api/tasks", { method: "POST", body: { origin: jira, repoId } });
    expect(taskSchema.parse(await res.json()).title).toBe("ABC-12");

    originTitle.mockRejectedValueOnce(
      new MissingCredentialError("jira", "acme.atlassian.net", null),
    );
    const missing = await request("/api/tasks", { method: "POST", body: { origin: jira, repoId } });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: "MissingCredential" });
  });

  describe("GitHub issue start comments and assignment", () => {
    const issueOrigin = {
      kind: "github-issue",
      url: "https://github.com/acme/web/issues/7",
      owner: "acme",
      repo: "web",
      number: 7,
      connectionId: null,
    } as const;
    let commentOnIssue: ReturnType<
      typeof vi.fn<(origin: unknown, body: string) => Promise<{ url: string }>>
    >;
    let assignIssue: ReturnType<typeof vi.fn<(origin: unknown) => Promise<unknown>>>;
    let order: string[];

    beforeEach(() => {
      order = [];
      commentOnIssue = vi.fn(async () => {
        order.push("comment");
        return { url: "https://github.com/acme/web/issues/7#issuecomment-1" };
      });
      assignIssue = vi.fn(async () => {
        order.push("assign");
        return { login: "kari" };
      });
      vi.mocked(pipeline.createTask).mockImplementation((values) => {
        order.push("create");
        return repositories.tasks.create({ ...values, status: "queued" });
      });
      app = createApp({
        token: launchToken,
        getPort: () => port,
        tasks: stores(),
        pipeline,
        taskServices: {
          newTask: {
            repos: { use: (id) => repositories.repos.get(id)! },
            resolveRoles: (overrides = {}) => ({ ...overrides }),
            resolveClis,
            originTitle,
            commentOnIssue,
            assignIssue,
          },
        },
      }).app;
    });

    it("posts the confirmed comment before creating the task", async () => {
      const res = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId, startComment: { body: "Work has started." } },
      });
      expect(res.status).toBe(201);
      expect(commentOnIssue).toHaveBeenCalledWith(issueOrigin, "Work has started.");
      expect(order).toEqual(["comment", "create"]);
      expect(vi.mocked(pipeline.createTask).mock.calls[0]![0]).not.toHaveProperty("startComment");
      // Like any task, it runs on the repo's default CLI.
      expect(vi.mocked(pipeline.createTask).mock.calls[0]![0]).toMatchObject({
        cli: repositories.repos.get(repoId)!.defaultCli,
        agentClis: {},
      });
    });

    it("creates no task when the comment fails, and surfaces a missing token", async () => {
      commentOnIssue.mockRejectedValueOnce(new Error("github.com: access denied"));
      const failed = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId, startComment: { body: "Started." } },
      });
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "github.com: access denied" });

      commentOnIssue.mockRejectedValueOnce(
        new MissingCredentialError("github", "github.com", null),
      );
      const missing = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId, startComment: { body: "Started." } },
      });
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ error: "MissingCredential" });
      expect(pipeline.createTask).not.toHaveBeenCalled();
      expect(repositories.tasks.list()).toEqual([]);
    });

    it("posts nothing without a start comment, and refuses one on other origins", async () => {
      const res = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId },
      });
      expect(res.status).toBe(201);
      expect(commentOnIssue).not.toHaveBeenCalled();

      const pr = await request("/api/tasks", {
        method: "POST",
        body: { origin: prOrigin, mode: "work", repoId, startComment: { body: "Started." } },
      });
      expect(pr.status).toBe(400);
      expect(commentOnIssue).not.toHaveBeenCalled();
    });

    it("assigns the issue to the user before creating the task", async () => {
      const res = await request("/api/tasks", {
        method: "POST",
        body: {
          origin: issueOrigin,
          repoId,
          startComment: { body: "Started." },
          assignToMe: true,
        },
      });
      expect(res.status).toBe(201);
      expect(assignIssue).toHaveBeenCalledTimes(1);
      expect(assignIssue).toHaveBeenCalledWith(issueOrigin);
      expect(order).toEqual(["comment", "assign", "create"]);
      expect(vi.mocked(pipeline.createTask).mock.calls[0]![0]).not.toHaveProperty("assignToMe");
    });

    it("creates no task when assigning fails, and surfaces a missing token", async () => {
      assignIssue.mockRejectedValueOnce(new Error("github.com: access denied"));
      const failed = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId, assignToMe: true },
      });
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "github.com: access denied" });

      assignIssue.mockRejectedValueOnce(new MissingCredentialError("github", "github.com", null));
      const missing = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId, assignToMe: true },
      });
      expect(missing.status).toBe(409);
      expect(await missing.json()).toMatchObject({ error: "MissingCredential" });
      expect(pipeline.createTask).not.toHaveBeenCalled();
      expect(repositories.tasks.list()).toEqual([]);
    });

    it("assigns nothing without assignToMe, and refuses it on other origins", async () => {
      const res = await request("/api/tasks", {
        method: "POST",
        body: { origin: issueOrigin, repoId },
      });
      expect(res.status).toBe(201);
      expect(assignIssue).not.toHaveBeenCalled();

      const freeText = await request("/api/tasks", {
        method: "POST",
        body: { origin: { kind: "free-text" }, freeText: "Fix it", repoId, assignToMe: true },
      });
      expect(freeText.status).toBe(400);
      expect(assignIssue).not.toHaveBeenCalled();
    });
  });

  it("returns a task's per-round diffs", async () => {
    const task = repositories.tasks.create({ title: "T", origin: { kind: "free-text" }, repoId });
    const res = await request(`/api/tasks/${task.id}/diffs`);
    expect(taskDiffSchema.array().parse(await res.json())).toEqual([
      { round: 0, from: "abc", to: "def", reviewed: true, diff: `diff for ${task.id}` },
    ]);
    expect((await request("/api/tasks/nope/diffs")).status).toBe(404);
  });

  it("lists a task's artifacts", async () => {
    const task = repositories.tasks.create({ title: "T", origin: { kind: "free-text" }, repoId });
    const res = await request(`/api/tasks/${task.id}/artifacts`);
    expect(taskArtifactSchema.array().parse(await res.json())).toEqual([
      { path: "ui/home.png", size: 3, modifiedAt: new Date("2026-01-02T03:04:05Z") },
    ]);
    expect((await request("/api/tasks/nope/artifacts")).status).toBe(404);
  });

  it("returns a task's whole branch diff, null when the service has none, 404 when unknown", async () => {
    const task = repositories.tasks.create({ title: "T", origin: { kind: "free-text" }, repoId });
    const res = await request(`/api/tasks/${task.id}/branch-diff`);
    expect(res.status).toBe(200);
    expect(branchDiffSchema.parse(await res.json())).toEqual({
      from: "abc",
      to: "def",
      diff: `branch diff for ${task.id}`,
    });
    expect(branchDiff).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));

    // E.g. a task whose worktree is gone: the service has no diff to show.
    branchDiff.mockResolvedValueOnce(null);
    const none = await request(`/api/tasks/${task.id}/branch-diff`);
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();

    expect((await request("/api/tasks/nope/branch-diff")).status).toBe(404);
    expect(branchDiff).toHaveBeenCalledTimes(2);
  });

  it("serves an artifact as an image with nosniff, 404 when missing", async () => {
    const task = repositories.tasks.create({ title: "T", origin: { kind: "free-text" }, repoId });
    const res = await request(`/api/tasks/${task.id}/artifacts/ui/home.png?v=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
    expect((await request(`/api/tasks/${task.id}/artifacts/ui/other.png`)).status).toBe(404);
    expect((await request("/api/tasks/nope/artifacts/ui/home.png")).status).toBe(404);
  });
});

describe("fallbackTitle", () => {
  it("uses the first line of free text, cut to 120 characters", () => {
    expect(fallbackTitle({ kind: "free-text" }, "\n  Fix it  \nmore")).toBe("Fix it");
    expect(fallbackTitle({ kind: "free-text" }, "")).toBe("Untitled task");
    expect(fallbackTitle({ kind: "free-text" }, "x".repeat(200))).toHaveLength(120);
  });

  it("uses the Jira key or the PR reference", () => {
    expect(fallbackTitle({ kind: "jira-issue", key: "ABC-1", connectionId: null }, "ctx")).toBe(
      "ABC-1",
    );
    expect(fallbackTitle(prOriginFor(7), "")).toBe("acme/web#7");
    expect(
      fallbackTitle({ ...prOriginFor(8), kind: "github-issue", url: "https://x/issues/8" }, ""),
    ).toBe("acme/web#8");
  });
});

function prOriginFor(number: number) {
  return {
    kind: "github-pr" as const,
    url: `https://github.com/acme/web/pull/${number}`,
    owner: "acme",
    repo: "web",
    number,
    connectionId: null,
  };
}
