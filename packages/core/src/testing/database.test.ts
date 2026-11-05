import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedDatabase } from "../db/database.js";
import { createRepositories } from "../db/repositories.js";
import { openTestDatabase } from "./database.js";

let dir: string;
const opened: OpenedDatabase[] = [];

function open(dataDir: string): OpenedDatabase {
  const db = openTestDatabase(dataDir);
  opened.push(db);
  return db;
}

function hasTasksTable(db: OpenedDatabase): boolean {
  return (
    db.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() !== undefined
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-testdb-"));
});

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openTestDatabase", () => {
  it("opens a migrated file database in WAL mode with foreign keys on", () => {
    const db = open(join(dir, "a"));
    expect(db.path).toBe(join(dir, "a", "blackwall.db"));
    expect(hasTasksTable(db)).toBe(true);
    expect(db.db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("opens a migrated in-memory database with foreign keys on", () => {
    const db = open(":memory:");
    expect(db.path).toBe(":memory:");
    expect(hasTasksTable(db)).toBe(true);
    expect(db.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("gives every database its own data", () => {
    for (const [first, second] of [
      [join(dir, "a"), join(dir, "b")],
      [":memory:", ":memory:"],
    ] as const) {
      createRepositories(open(first).db).repos.create({ path: "/code/app", name: "app" });
      expect(createRepositories(open(second).db).repos.list()).toEqual([]);
    }
  });

  it("keeps the data of a directory it reopens", () => {
    const first = open(dir);
    createRepositories(first.db).repos.create({ path: "/code/app", name: "app" });
    first.close();
    const reopened = open(dir);
    expect(
      createRepositories(reopened.db)
        .repos.list()
        .map((r) => r.name),
    ).toEqual(["app"]);
  });
});
