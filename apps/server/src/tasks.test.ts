import {
  FindingNotFoundError,
  TaskStateError,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  findingSchema,
  grillAnswerResultSchema,
  grillQuestionSchema,
  taskSchema,
  type GateResponseInput,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import type { TaskPipeline } from "./tasks.js";

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
        if (input.gate !== "plan-approval")
          throw new TaskStateError(`Task ${id} is not waiting on ${input.gate}`);
        return repositories.tasks.update(id, { status: "queued", gate: null, stage: "implement" });
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
