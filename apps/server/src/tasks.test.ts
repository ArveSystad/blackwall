import {
  FindingNotFoundError,
  MissingCredentialError,
  TaskStateError,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  deliveryPlanSchema,
  findingSchema,
  grillAnswerResultSchema,
  grillQuestionSchema,
  runSchema,
  stepEventSchema,
  stepSchema,
  taskDiffSchema,
  taskSchema,
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
      body: { gate: "finish", decision: "approve", delivery: { actions: ["merge-main"] } },
    });
    expect(done.status).toBe(200);
    expect(pipeline.respond).toHaveBeenCalledWith(task.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["merge-main"], squash: false, findingIds: [] },
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
});

describe("new tasks", () => {
  let pipeline: TaskPipeline;
  let originTitle: ReturnType<typeof vi.fn<(origin: unknown) => Promise<string | undefined>>>;
  let repoId: string;

  beforeEach(() => {
    repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
    pipeline = {
      createTask: vi.fn((values) => repositories.tasks.create({ ...values, status: "queued" })),
      resume: vi.fn(),
      respond: vi.fn(),
      answerQuestion: vi.fn(),
      overrideFinding: vi.fn(),
      deliveryPlan: vi.fn(),
    };
    originTitle = vi.fn(async () => "Persist wizard progress");
    app = createApp({
      token: launchToken,
      getPort: () => port,
      tasks: stores(),
      pipeline,
      taskServices: {
        newTask: {
          repos: { use: (id) => repositories.repos.get(id)! },
          resolveRoles: (overrides = {}) => ({ planner: "a-default", ...overrides }),
          originTitle,
        },
        diffs: async (task) => [
          { round: 0, from: "abc", to: "def", reviewed: true, diff: `diff for ${task.id}` },
        ],
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

  it("returns a task's per-round diffs", async () => {
    const task = repositories.tasks.create({ title: "T", origin: { kind: "free-text" }, repoId });
    const res = await request(`/api/tasks/${task.id}/diffs`);
    expect(taskDiffSchema.array().parse(await res.json())).toEqual([
      { round: 0, from: "abc", to: "def", reviewed: true, diff: `diff for ${task.id}` },
    ]);
    expect((await request("/api/tasks/nope/diffs")).status).toBe(404);
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
