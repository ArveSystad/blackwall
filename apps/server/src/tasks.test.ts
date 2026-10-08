import {
  createRepositories,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import { taskSchema } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

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

function request(path: string) {
  return app.request(`http://${host}${path}`, { headers: { host, cookie } });
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
