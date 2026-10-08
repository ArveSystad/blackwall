import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DB_FILENAME, openDatabase, resolveDataDir, type OpenedDatabase } from "./database.js";
import { createRepositories } from "./repositories.js";

describe("resolveDataDir", () => {
  it("defaults to ~/.blackwall", () => {
    expect(resolveDataDir({})).toBe(join(homedir(), ".blackwall"));
  });

  it("honours BLACKWALL_HOME", () => {
    expect(resolveDataDir({ BLACKWALL_HOME: "/data/bw" })).toBe("/data/bw");
  });
});

describe("openDatabase", () => {
  let dir: string;
  let opened: OpenedDatabase | undefined;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "blackwall-db-")), "nested");
  });

  afterEach(() => {
    opened?.close();
    opened = undefined;
    rmSync(join(dir, ".."), { recursive: true, force: true });
  });

  it("creates the data dir and database, in WAL mode with foreign keys on", () => {
    opened = openDatabase(dir);
    expect(opened.path).toBe(join(dir, DB_FILENAME));
    expect(existsSync(opened.path)).toBe(true);
    expect(opened.db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(opened.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);

    const tables = opened.db.$client
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining([
        "agents",
        "connections",
        "findings",
        "grill_questions",
        "repos",
        "runs",
        "settings",
        "step_events",
        "steps",
        "tags",
        "tasks",
      ]),
    );
  });

  it("is idempotent across restarts and keeps data", () => {
    opened = openDatabase(dir);
    createRepositories(opened.db).settings.set("concurrency", 3);
    const migrations = () =>
      opened!.db.$client.prepare("select count(*) from __drizzle_migrations").pluck().get();
    const applied = migrations();
    opened.close();

    opened = openDatabase(dir);
    expect(migrations()).toBe(applied);
    expect(createRepositories(opened.db).settings.get("concurrency")).toBe(3);
  });
});
