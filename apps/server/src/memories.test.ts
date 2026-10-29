import {
  createRepositories,
  MemoryBackfillBusyError,
  openDatabase,
  type OpenedDatabase,
  type Repositories,
} from "@blackwall/core";
import {
  MAX_MEMORY_CHARS,
  memoryBackfillStatusSchema,
  memorySchema,
  repoMemoriesSchema,
  type MemoryBackfillStatus,
} from "@blackwall/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { errorResponse } from "./errors.js";
import { memoryRoutes } from "./memories.js";

let opened: OpenedDatabase;
let repositories: Repositories;
let app: Hono;
let repoId: string;

beforeEach(() => {
  opened = openDatabase(":memory:");
  repositories = createRepositories(opened.db);
  repoId = repositories.repos.create({ path: "/code/app", name: "app" }).id;
  app = new Hono()
    .onError(errorResponse)
    .route(
      "/api/repos/:repoId/memories",
      memoryRoutes({ memories: repositories.memories, repos: repositories.repos }),
    );
});

afterEach(() => opened.close());

function request(
  path: string,
  init: { method?: string; body?: unknown; repo?: string } = {},
): Promise<Response> {
  return app.request(`http://localhost/api/repos/${init.repo ?? repoId}/memories${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const note = (text: string, extra: Record<string, unknown> = {}) =>
  repositories.memories.create({ repoId, kind: "convention", text, ...extra });

async function list() {
  return repoMemoriesSchema.parse(await (await request("")).json());
}

describe("memory routes", () => {
  it("lists active notes pinned first, then newest, and held notes apart", async () => {
    note("Old");
    note("Pinned", { pinned: true });
    note("New");
    note("Held", { awaitingMerge: true });
    const { memories, awaitingMerge } = await list();
    expect(memories.map((m) => m.text)).toEqual(["Pinned", "New", "Old"]);
    expect(awaitingMerge.map((m) => m.text)).toEqual(["Held"]);
  });

  it("adds a user note without a source task and rejects invalid ones", async () => {
    const created = await request("", {
      method: "POST",
      body: { kind: "pitfall", text: "  Run codegen first ", files: [] },
    });
    expect(created.status).toBe(201);
    const memory = memorySchema.parse(await created.json());
    expect(memory).toMatchObject({
      repoId,
      sourceTaskId: null,
      kind: "pitfall",
      text: "Run codegen first",
      files: null,
      editedAt: null,
    });
    for (const body of [
      { kind: "rumour", text: "x" },
      { kind: "context", text: "   " },
      { kind: "context", text: "x".repeat(MAX_MEMORY_CHARS + 1) },
    ]) {
      expect((await request("", { method: "POST", body })).status).toBe(400);
    }
    expect((await list()).memories).toHaveLength(1);
  });

  it("edits text, kind, files and pin and marks the note edited", async () => {
    const m = note("Use npm", { files: ["package.json"] });
    const res = await request(`/${m.id}`, {
      method: "PATCH",
      body: { kind: "command", text: "Use pnpm", files: ["pnpm-lock.yaml"], pinned: true },
    });
    expect(res.status).toBe(200);
    const edited = memorySchema.parse(await res.json());
    expect(edited).toMatchObject({
      kind: "command",
      text: "Use pnpm",
      files: ["pnpm-lock.yaml"],
      pinned: true,
    });
    expect(edited.editedAt).toBeInstanceOf(Date);
    const cleared = await request(`/${m.id}`, { method: "PATCH", body: { files: [] } });
    expect(memorySchema.parse(await cleared.json()).files).toBeNull();
    expect((await request(`/${m.id}`, { method: "PATCH", body: { text: "" } })).status).toBe(400);
  });

  it("treats another repo's note, an unknown id and an unknown repo as missing", async () => {
    const other = repositories.repos.create({ path: "/code/other", name: "other" });
    const foreign = repositories.memories.create({
      repoId: other.id,
      kind: "context",
      text: "Other repo",
    });
    const patched = await request(`/${foreign.id}`, { method: "PATCH", body: { text: "Mine" } });
    expect(patched.status).toBe(404);
    expect((await request(`/${foreign.id}`, { method: "DELETE" })).status).toBe(404);
    expect(repositories.memories.get(foreign.id)).toEqual(foreign);
    expect((await request("/nope", { method: "DELETE" })).status).toBe(404);
    expect((await request("", { repo: "nope" })).status).toBe(404);
  });

  it("deletes a note", async () => {
    const m = note("Gone soon");
    expect((await request(`/${m.id}`, { method: "DELETE" })).status).toBe(204);
    expect(repositories.memories.get(m.id)).toBeUndefined();
  });

  it("edits and deletes held notes", async () => {
    const held = note("Held", { awaitingMerge: true });
    const res = await request(`/${held.id}`, { method: "PATCH", body: { text: "Held, fixed" } });
    expect(memorySchema.parse(await res.json())).toMatchObject({
      text: "Held, fixed",
      awaitingMerge: true,
    });
    expect((await request(`/${held.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await list()).awaitingMerge).toEqual([]);
  });

  it("keeps a user-edited note when Summarize replaces the task's notes", async () => {
    const task = repositories.tasks.create({
      title: "Fix login",
      origin: { kind: "free-text" },
      repoId,
    });
    const [saved] = repositories.memories.replaceForTask(task.id, repoId, [
      { kind: "convention", text: "Saved by Summarize" },
    ]);
    await request(`/${saved!.id}`, { method: "PATCH", body: { pinned: true } });
    repositories.memories.replaceForTask(task.id, repoId, [
      { kind: "convention", text: "A newer summary" },
    ]);
    expect((await list()).memories.map((m) => m.text)).toEqual([
      "Saved by Summarize",
      "A newer summary",
    ]);
  });
});

describe("memory backfill routes", () => {
  const idle: MemoryBackfillStatus = {
    running: false,
    pending: 2,
    done: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
  };

  function withBackfill(start: (repoId: string) => MemoryBackfillStatus) {
    const started: string[] = [];
    app = new Hono().onError(errorResponse).route(
      "/api/repos/:repoId/memories",
      memoryRoutes({
        memories: repositories.memories,
        repos: repositories.repos,
        backfill: {
          status: () => idle,
          start: (id) => {
            started.push(id);
            return start(id);
          },
        },
      }),
    );
    return started;
  }

  it("reports the status and starts a pass", async () => {
    const started = withBackfill(() => ({ ...idle, running: true }));
    const status = await request("/backfill");
    expect(status.status).toBe(200);
    expect(memoryBackfillStatusSchema.parse(await status.json())).toEqual(idle);
    const res = await request("/backfill", { method: "POST" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ running: true, pending: 2 });
    expect(started).toEqual([repoId]);
  });

  it("refuses a second pass with 409", async () => {
    withBackfill(() => {
      throw new MemoryBackfillBusyError();
    });
    expect((await request("/backfill", { method: "POST" })).status).toBe(409);
  });

  it("answers 404 for an unknown repo, and without a backfill", async () => {
    const started = withBackfill(() => idle);
    expect((await request("/backfill", { repo: "nope" })).status).toBe(404);
    expect((await request("/backfill", { method: "POST", repo: "nope" })).status).toBe(404);
    expect(started).toEqual([]);

    app = new Hono()
      .onError(errorResponse)
      .route(
        "/api/repos/:repoId/memories",
        memoryRoutes({ memories: repositories.memories, repos: repositories.repos }),
      );
    expect((await request("/backfill")).status).toBe(404);
    expect((await request("/backfill", { method: "POST" })).status).toBe(404);
  });
});
