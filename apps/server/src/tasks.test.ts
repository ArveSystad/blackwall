import {
  TaskStateError,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import { taskSchema, type GateResponseInput } from "@blackwall/shared";
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
  app = createApp({ token: launchToken, getPort: () => port, tasks: repositories.tasks }).app;
});

afterEach(() => opened.close());

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
      respond: vi.fn(async (id: string, input: GateResponseInput) => {
        if (input.gate !== "plan-approval")
          throw new TaskStateError(`Task ${id} is not waiting on ${input.gate}`);
        return repositories.tasks.update(id, { status: "queued", gate: null, stage: "implement" });
      }),
    };
    app = createApp({
      token: launchToken,
      getPort: () => port,
      tasks: repositories.tasks,
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
});
