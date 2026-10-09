import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DB_FILENAME,
  MIGRATIONS_DIR,
  openDatabase,
  resolveDataDir,
  type OpenedDatabase,
} from "./database.js";
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

  it("upgrades a 0000_init database without losing child rows", () => {
    // Build a database at the first migration only, with a task that has a run.
    const oldMigrations = join(dir, "..", "migrations-0000");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 1);
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    sqlite.exec(`
      insert into repos (id, path, name, created_at, updated_at) values ('r1', '/code/app', 'app', 0, 0);
      insert into tasks (id, title, origin_kind, origin, repo_id, created_at, updated_at)
        values ('t1', 'Fix login', 'jira-issue', '{"key":"ABC-1","connectionId":null}', 'r1', 0, 0);
      insert into runs (id, task_id, number, created_at) values ('u1', 't1', 1, 0);
    `);
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    expect(r.tasks.get("t1")).toMatchObject({
      origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
      status: "queued",
      stage: null,
    });
    expect(r.runs.listByTask("t1")).toHaveLength(1);
  });

  it("switches repos with a jbf.ghe.com origin to Copilot when adding the default CLI", () => {
    // Build a database at the migration before the repo default CLI.
    const oldMigrations = join(dir, "..", "migrations-0005");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0006_repo_default_cli"),
    );
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    const insert = sqlite.prepare(
      "insert into repos (id, path, name, remote_url, created_at, updated_at) values (?, ?, ?, ?, 0, 0)",
    );
    insert.run("https", "/code/a", "a", "https://jbf.ghe.com/o/r.git");
    insert.run("ssh", "/code/b", "b", "git@JBF.ghe.com:o/r.git");
    insert.run("github", "/code/c", "c", "https://github.com/o/r.git");
    insert.run("none", "/code/d", "d", null);
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    const cli = (id: string) => r.repos.get(id)?.defaultCli;
    expect(cli("https")).toBe("copilot");
    expect(cli("ssh")).toBe("copilot");
    expect(cli("github")).toBe("claude");
    expect(cli("none")).toBe("claude");
  });
});
