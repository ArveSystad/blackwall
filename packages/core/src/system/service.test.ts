import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILENAME, MIGRATIONS_DIR, openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { ARTIFACTS_DIR } from "../pipeline/artifacts.js";
import { DatabaseBusyError, createSystemService } from "./service.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-system-"));
  opened = openDatabase(join(dir, "data"));
  r = createRepositories(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = () =>
  createSystemService({ dataDir: join(dir, "data"), db: opened.db, tasks: r.tasks });

function seedTask(worktreePath: string | null = null) {
  const repo = r.repos.get("r1") ?? r.repos.create({ id: "r1", path: "/code/app", name: "app" });
  const task = r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
  });
  return worktreePath ? r.tasks.update(task.id, { worktreePath }) : task;
}

describe("snapshot", () => {
  it("reports the database files, migrations and tables", async () => {
    const info = await service().snapshot();
    expect(info.dataDir).toBe(join(dir, "data"));
    expect(info.database.path.endsWith(DB_FILENAME)).toBe(true);
    expect(info.database.fileBytes).toBeGreaterThan(0);
    expect(info.database.totalBytes).toBe(
      info.database.fileBytes + info.database.walBytes + info.database.shmBytes,
    );

    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(info.database.migrations).toEqual({
      applied: journal.entries.length,
      available: journal.entries.length,
      latest: journal.entries.at(-1)?.tag,
    });

    const names = info.database.tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["tasks", "step_events", "findings"]));
    expect(names).not.toContain("__drizzle_migrations");
    expect(names.some((n) => n.startsWith("sqlite_"))).toBe(false);
    expect(info.runningTasks).toBe(0);
  });

  it("counts rows and sizes per table", async () => {
    const run = r.runs.create(seedTask().id);
    const step = r.steps.create({ runId: run.id, stage: "inform" });
    for (let i = 0; i < 3; i++) {
      r.stepEvents.append(step.id, "message", { type: "message", text: `hi ${i}` });
    }
    const info = await service().snapshot();
    const stepEvents = info.database.tables.find((t) => t.name === "step_events");
    expect(stepEvents?.rows).toBe(3);
    expect(info.database.dbstat).toBe(true);
    expect(stepEvents?.bytes).toBeGreaterThan(0);
  });

  it("counts existing worktrees and their artifacts, and sizes them on demand", async () => {
    const worktree = join(dir, "wt");
    mkdirSync(join(worktree, ARTIFACTS_DIR), { recursive: true });
    writeFileSync(join(worktree, ARTIFACTS_DIR, "a.png"), "0123456789");
    writeFileSync(join(worktree, "README.md"), "hello world");
    seedTask(worktree);
    seedTask(join(dir, "gone"));

    const cheap = await service().snapshot();
    expect(cheap.worktrees).toEqual({
      count: 1,
      artifactCount: 1,
      artifactBytes: 10,
      totalBytes: null,
    });
    const full = await service().snapshot({ worktreeSizes: true });
    expect(full.worktrees.totalBytes).toBeGreaterThanOrEqual(21);
  });

  it("leaves table sizes out when dbstat is unavailable", async () => {
    const client = opened.db.$client;
    const noDbstat = new Proxy(client, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("dbstat")) throw new Error("no such table: dbstat");
            return target.prepare(sql);
          };
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(opened.db, {
      get: (target, prop) => (prop === "$client" ? noDbstat : Reflect.get(target, prop)),
    });
    const info = await createSystemService({ dataDir: dir, db, tasks: r.tasks }).snapshot();
    expect(info.database.dbstat).toBe(false);
    expect(info.database.tables.every((t) => t.bytes === null)).toBe(true);
  });
});

describe("compact", () => {
  it("refuses while a task is running", async () => {
    r.tasks.update(seedTask().id, { status: "running" });
    await expect(service().compact()).rejects.toThrow(DatabaseBusyError);
  });

  it("vacuums and empties the WAL", async () => {
    const run = r.runs.create(seedTask().id);
    const step = r.steps.create({ runId: run.id, stage: "inform" });
    for (let i = 0; i < 500; i++) {
      r.stepEvents.append(step.id, "message", { type: "message", text: "x".repeat(500) });
    }
    opened.db.$client.exec("delete from step_events");

    const { info, freedBytes } = await service().compact();
    expect(freedBytes).toBeGreaterThanOrEqual(0);
    expect(info.database.walBytes).toBe(0);
    expect(info.database.tables.find((t) => t.name === "step_events")?.rows).toBe(0);
  });
});
