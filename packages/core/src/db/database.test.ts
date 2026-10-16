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
      followUps: [],
      baseBranch: null,
    });
    expect(r.runs.listByTask("t1")).toHaveLength(1);
  });

  it("switches repos with a GHE (*.ghe.com) origin to Copilot when adding the default CLI", () => {
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
    insert.run("https", "/code/a", "a", "https://acme.ghe.com/o/r.git");
    insert.run("ssh", "/code/b", "b", "git@ACME.ghe.com:o/r.git");
    insert.run("tenant", "/code/e", "e", "ssh://git@other.ghe.com:2222/o/r.git");
    insert.run("github", "/code/c", "c", "https://github.com/o/r.git");
    insert.run("none", "/code/d", "d", null);
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    const cli = (id: string) => r.repos.get(id)?.defaultCli;
    expect(cli("https")).toBe("copilot");
    expect(cli("ssh")).toBe("copilot");
    expect(cli("tenant")).toBe("copilot");
    expect(cli("github")).toBe("claude");
    expect(cli("none")).toBe("claude");
  });

  it("moves each agent's CLI onto its tasks, backlog items and steps when agents lose it", () => {
    // Build a database at the migration before CLI-agnostic agents.
    const oldMigrations = join(dir, "..", "migrations-0010");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0011_cli_agnostic_agents"),
    );
    expect(journal.entries.at(-1)?.tag).toBe("0010_task_follow_ups");
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    sqlite.exec(`
      insert into repos (id, path, name, default_cli, created_at, updated_at)
        values ('cp', '/code/cp', 'cp', 'copilot', 0, 0), ('cc', '/code/cc', 'cc', 'claude', 0, 0);
      insert into agents (id, name, cli, model, permission_overrides, created_at, updated_at)
        values ('claude', 'Planner', 'claude', 'opus', '{"allow":["Read"]}', 0, 0),
               ('copilot', 'Reviewer', 'copilot', null, '{}', 0, 0);
      insert into tasks (id, title, origin, repo_id, agents, follow_ups, created_at, updated_at)
        values ('t1', 'Fix login', '{"kind":"free-text"}', 'cp',
                '{"planner":"claude","planReviewers":["claude"],"codeReviewers":["copilot"]}',
                '[{"title":"Tidy up","description":"Later.","repoId":null}]', 0, 0),
               ('t2', 'Fix logout', '{"kind":"free-text"}', 'cc', '{"planner":"claude"}', '[]', 0, 0);
      insert into backlog_items (id, repo_id, title, origin, agents, source_task_id, created_at, updated_at)
        values ('b1', 'cc', 'Later', '{"kind":"free-text"}',
                '{"planner":"claude","codeReviewers":["copilot"]}', 't1', 0, 0);
      insert into runs (id, task_id, number, created_at) values ('u1', 't1', 1, 0);
      insert into steps (id, run_id, stage, agent_id, created_at)
        values ('s1', 'u1', 'inform', 'claude', 0), ('s2', 'u1', 'code-review', 'copilot', 0),
               ('s3', 'u1', 'checks', null, 0);
      insert into findings (id, task_id, step_id, reviewer_agent_id, severity, title, explanation, created_at, updated_at)
        values ('f1', 't1', 's2', 'copilot', 'low', 'Typo', 'A typo.', 0, 0);
    `);
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    expect(r.agents.get("claude")).toMatchObject({
      models: { claude: "opus" },
      permissionOverrides: { claude: { allow: ["Read"] } },
    });
    expect(r.agents.get("copilot")).toMatchObject({ models: {}, permissionOverrides: {} });
    expect(r.agents.get("claude")).not.toHaveProperty("cli");
    expect(r.tasks.get("t1")).toMatchObject({ cli: "copilot", agentClis: { claude: "claude" } });
    expect(r.tasks.get("t2")).toMatchObject({ cli: "claude", agentClis: {} });
    expect(r.backlogItems.get("b1")).toMatchObject({
      agentClis: { copilot: "copilot" },
      sourceTaskId: "t1",
    });
    expect(r.tasks.get("t1")?.followUps).toEqual([
      { title: "Tidy up", description: "Later.", repoId: null },
    ]);
    expect(r.steps.get("s1")).toMatchObject({ agentId: "claude", cli: "claude" });
    expect(r.steps.get("s2")).toMatchObject({ agentId: "copilot", cli: "copilot" });
    expect(r.steps.get("s3")).toMatchObject({ agentId: null, cli: null });
    expect(r.findings.get("f1")).toMatchObject({ stepId: "s2", reviewerAgentId: "copilot" });
  });

  it("gives repos registered before per-repo default branches main", () => {
    // Build a database at the migration before the repo default branch.
    const oldMigrations = join(dir, "..", "migrations-0015");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0016_repo_default_branch"),
    );
    expect(journal.entries.at(-1)?.tag).toBe("0015_task_base_branch");
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    sqlite.exec(
      "insert into repos (id, path, name, created_at, updated_at) values ('r1', '/code/a', 'a', 0, 0)",
    );
    sqlite.close();

    opened = openDatabase(dir);
    expect(createRepositories(opened.db).repos.get("r1")?.defaultBranch).toBe("main");
  });

  it("adds an empty chat_messages table to an existing database", () => {
    // Build a database at the migration before the chat messages.
    const oldMigrations = join(dir, "..", "migrations-0016");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0017_chat_messages"),
    );
    expect(journal.entries.at(-1)?.tag).toBe("0016_repo_default_branch");
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    sqlite.exec(
      "insert into repos (id, path, name, created_at, updated_at) values ('r1', '/code/a', 'a', 0, 0)",
    );
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    expect(r.repos.get("r1")?.name).toBe("a");
    expect(r.chatMessages.list("r1")).toEqual([]);
    r.chatMessages.insert({ repoId: "r1", role: "user", text: "Hi" });
    expect(r.chatMessages.list("r1")).toHaveLength(1);
  });

  it("backfills step usage from the stored usage and result events", () => {
    // Build a database at the migration before the step usage columns.
    const oldMigrations = join(dir, "..", "migrations-0017");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0018_step_usage"),
    );
    expect(journal.entries.at(-1)?.tag).toBe("0017_chat_messages");
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    const usage = (output: number, cost?: number) =>
      JSON.stringify({
        inputTokens: 1,
        outputTokens: output,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        ...(cost !== undefined ? { costUsd: cost } : {}),
      });
    sqlite.exec(`
      insert into repos (id, path, name, created_at, updated_at) values ('r1', '/code/a', 'a', 0, 0);
      insert into tasks (id, title, origin, repo_id, created_at, updated_at)
        values ('t1', 'Fix login', '{"kind":"free-text"}', 'r1', 0, 0);
      insert into runs (id, task_id, number, created_at) values ('u1', 't1', 1, 0);
      insert into steps (id, run_id, stage, created_at)
        values ('claude', 'u1', 'implement', 0), ('opencode', 'u1', 'implement', 0),
               ('none', 'u1', 'checks', 0);
    `);
    const insert = sqlite.prepare(
      "insert into step_events (step_id, seq, type, payload, created_at) values (?, ?, ?, ?, 0)",
    );
    const usageEvent = (output: number, cost?: number) =>
      `{"type":"usage","usage":${usage(output, cost)}}`;
    const resultEvent = (output: number, cost?: number) =>
      `{"type":"result","result":{"sessionId":"x","text":"ok","usage":${usage(output, cost)}}}`;
    // Claude: streamed usage undercounts output and carries no cost; the result has both.
    insert.run("claude", 1, "usage", usageEvent(3));
    insert.run("claude", 2, "usage", usageEvent(3));
    insert.run("claude", 3, "result", resultEvent(500, 0.05));
    // OpenCode: the result is the events' sum, cost included.
    insert.run("opencode", 1, "usage", usageEvent(4, 0.01));
    insert.run("opencode", 2, "usage", usageEvent(6, 0.02));
    insert.run("opencode", 3, "result", resultEvent(10, 0.03));
    sqlite.close();

    opened = openDatabase(dir);
    const r = createRepositories(opened.db);
    expect(r.steps.get("claude")).toMatchObject({
      inputTokens: 2,
      outputTokens: 500,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      costUsd: 0.05,
    });
    const opencode = r.steps.get("opencode");
    expect(opencode).toMatchObject({ inputTokens: 2, outputTokens: 10, cacheReadTokens: 20 });
    expect(opencode?.costUsd).toBeCloseTo(0.03);
    expect(r.steps.get("none")).toMatchObject({ inputTokens: 0, outputTokens: 0, costUsd: null });
  });

  it("keeps the backlog's pick order when priority is dropped", () => {
    // Build a database at the migration before the backlog priority was dropped.
    const oldMigrations = join(dir, "..", "migrations-0019");
    cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
    const journalPath = join(oldMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag === "0020_drop_backlog_priority"),
    );
    expect(journal.entries.at(-1)?.tag).toBe("0019_ci_watch");
    writeFileSync(journalPath, JSON.stringify(journal));

    mkdirSync(dir, { recursive: true });
    const sqlite = new Database(join(dir, DB_FILENAME));
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations });
    sqlite.exec(`
      insert into repos (id, path, name, created_at, updated_at)
        values ('r1', '/code/a', 'a', 0, 0), ('r2', '/code/b', 'b', 0, 0);
      insert into backlog_items (id, repo_id, title, origin, priority, position, created_at, updated_at)
        values ('normal0', 'r1', 'Normal 0', '{"kind":"free-text"}', 'normal', 0, 0, 0),
               ('high', 'r1', 'High', '{"kind":"free-text"}', 'high', 5, 1, 1),
               ('low', 'r1', 'Low', '{"kind":"free-text"}', 'low', 1, 2, 2),
               ('normal2', 'r1', 'Normal 2', '{"kind":"free-text"}', 'normal', 2, 3, 3),
               ('other', 'r2', 'Other', '{"kind":"free-text"}', 'low', 7, 4, 4);
    `);
    sqlite.close();

    opened = openDatabase(dir);
    const columns = opened.db.$client.pragma("table_info(backlog_items)") as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("priority");
    const r = createRepositories(opened.db);
    const position = (id: string) => r.backlogItems.get(id)?.position;
    expect(["high", "normal0", "normal2", "low"].map(position)).toEqual([0, 1, 2, 3]);
    expect(position("other")).toBe(0);
  });
});
