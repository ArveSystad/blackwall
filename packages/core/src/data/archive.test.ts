import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_INTERRUPTED_ERROR, type DataManifest } from "@blackwall/shared";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUOTA_KEY } from "../agents/quota.js";
import { DB_FILENAME, MIGRATIONS_DIR, openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createConnectionTokens } from "../secrets/tokens.js";
import { createMemorySecretStore } from "../secrets/secret-store.js";
import {
  DataArchiveTooNewError,
  InvalidDataArchiveError,
  MANIFEST_FILENAME,
  TRANSCRIPT_EVENT_TYPES,
  backupDatabase,
  createExportArchive,
  migrationJournal,
  migrationLevel,
  readImportArchive,
  restoreDatabase,
  sqliteOf,
  type Sqlite,
} from "./archive.js";

const TOKEN = "ghp_archive_secret_123";
const NOW = new Date("2026-10-14T12:34:56.000Z");

let root: string;
let opened: OpenedDatabase[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blackwall-archive-"));
  opened = [];
});

afterEach(() => {
  for (const o of opened) o.close();
  rmSync(root, { recursive: true, force: true });
});

function open(name: string): { sqlite: Sqlite; r: Repositories; dir: string } {
  const dir = join(root, name);
  const o = openDatabase(dir);
  opened.push(o);
  return { sqlite: sqliteOf(o.db), r: createRepositories(o.db), dir };
}

/** Every user table's rows, in rowid order. */
function dump(sqlite: Sqlite): Record<string, unknown[]> {
  const tables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
        "AND name <> '__drizzle_migrations' AND name NOT LIKE 'memories_fts%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
  return Object.fromEntries(
    tables.map((t) => [t, sqlite.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]),
  );
}

async function seed(r: Repositories) {
  const store = createMemorySecretStore();
  const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });
  const connection = r.connections.create({
    name: "github.com",
    kind: "github",
    baseUrl: "https://api.github.com",
    authMeta: { login: "octo" },
  });
  await tokens.set(connection.id, TOKEN);
  const repo = r.repos.create({ path: "/code/app", name: "app", connectionId: connection.id });
  const agent = r.agents.create({ name: "Planner", prompt: "Plan it" });
  r.tags.replace(["security", "correctness"]);
  r.settings.set("maxTasksPerRepo", 2);
  const task = r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    worktreePath: "/code/app.worktrees/t1",
    status: "needs-you",
    gate: "finish",
  });
  const run = r.runs.create(task.id);
  const step = r.steps.create({ runId: run.id, stage: "implement", agentId: agent.id });
  r.stepEvents.append(step.id, "message", { text: "Thinking" });
  r.stepEvents.append(step.id, "tool-call-start", { name: "Read" });
  r.stepEvents.append(step.id, "result", { ok: true });
  r.stepEvents.append(step.id, "delivery.done", { kind: "push-branch" });
  r.stepEvents.append(step.id, "review.diff", { diff: "" });
  r.findings.createMany([
    {
      taskId: task.id,
      runId: run.id,
      stepId: step.id,
      severity: "high",
      title: "Leak",
      explanation: "It leaks",
    },
  ]);
  r.grillQuestions.create({ taskId: task.id, runId: run.id, question: "Why?" });
  r.memories.create({
    repoId: repo.id,
    sourceTaskId: task.id,
    kind: "pitfall",
    text: "Regenerate the client after editing the schema",
  });
  return { connection, repo, task, run, step };
}

function eventTypes(sqlite: Sqlite): string[] {
  return sqlite.prepare("SELECT type FROM step_events ORDER BY seq").pluck().all() as string[];
}

function archiveEntries(bytes: Uint8Array) {
  const entries = unzipSync(bytes);
  return {
    manifest: JSON.parse(strFromU8(entries[MANIFEST_FILENAME]!)) as DataManifest,
    db: entries[DB_FILENAME]!,
  };
}

function exportOf(sqlite: Sqlite, includeTranscripts = true) {
  return createExportArchive(sqlite, { includeTranscripts, version: "1.2.3", now: NOW });
}

describe("createExportArchive", () => {
  it("round-trips every table without the token", async () => {
    const source = open("source");
    await seed(source.r);
    const target = open("target");
    target.r.repos.create({ path: "/elsewhere", name: "other" });

    const bytes = exportOf(source.sqlite);
    const { db } = archiveEntries(bytes);
    expect(Buffer.from(bytes).includes(TOKEN)).toBe(false);
    expect(Buffer.from(db).includes(TOKEN)).toBe(false);
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual([DB_FILENAME, MANIFEST_FILENAME]);

    const archive = readImportArchive(bytes);
    try {
      expect(archive.migrated).toBe(false);
      restoreDatabase(target.sqlite, archive.dbPath);
    } finally {
      archive.cleanup();
    }

    const expected = dump(source.sqlite);
    expected.connections = expected.connections!.map((c) => ({
      ...(c as object),
      token_set: 0,
    }));
    expect(dump(target.sqlite)).toEqual(expected);
    expect(target.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(target.r.connections.list()[0]).toMatchObject({
      name: "github.com",
      authMeta: { login: "octo" },
      tokenSet: false,
    });
  });

  it("rebuilds the memories' full-text index on import", async () => {
    const source = open("source");
    const { repo } = await seed(source.r);
    const target = open("target");
    const archive = readImportArchive(exportOf(source.sqlite));
    try {
      restoreDatabase(target.sqlite, archive.dbPath);
    } finally {
      archive.cleanup();
    }
    expect(target.r.memories.relevant(repo.id, "regenerate").map((m) => m.text)).toEqual([
      "Regenerate the client after editing the schema",
    ]);
  });

  it("drops only transcript events from a light export", async () => {
    const source = open("source");
    await seed(source.r);

    const full = readImportArchive(exportOf(source.sqlite));
    const light = readImportArchive(exportOf(source.sqlite, false));
    try {
      expect(full.manifest.includesTranscripts).toBe(true);
      expect(light.manifest.includesTranscripts).toBe(false);
      const types = (path: string) => {
        const db = new Database(path, { readonly: true });
        try {
          return eventTypes(db);
        } finally {
          db.close();
        }
      };
      expect(types(full.dbPath)).toEqual([
        "message",
        "tool-call-start",
        "result",
        "delivery.done",
        "review.diff",
      ]);
      expect(types(light.dbPath)).toEqual(["result", "delivery.done", "review.diff"]);
    } finally {
      full.cleanup();
      light.cleanup();
    }
    // The live database keeps its transcripts.
    expect(eventTypes(source.sqlite)).toHaveLength(5);
  });

  it("pins the transcript event types", () => {
    expect([...TRANSCRIPT_EVENT_TYPES]).toEqual([
      "message",
      "tool-call-start",
      "tool-call-end",
      "subagent-start",
      "subagent-end",
    ]);
  });

  it("records this build's migration level in the manifest", () => {
    const source = open("source");
    const { manifest } = archiveEntries(exportOf(source.sqlite));
    const journal = migrationJournal();
    expect(manifest).toEqual({
      format: 1,
      app: "blackwall",
      blackwallVersion: "1.2.3",
      exportedAt: NOW.toISOString(),
      migration: { count: journal.length, tag: journal.at(-1)!.tag, when: journal.at(-1)!.when },
      includesTranscripts: true,
    });
  });
});

/** A database migrated up to `tag` only, built with a sliced copy of the journal. */
function databaseAt(tag: string): string {
  const migrations = join(root, `migrations-${tag}`);
  cpSync(MIGRATIONS_DIR, migrations, { recursive: true });
  const journalPath = join(migrations, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  writeFileSync(journalPath, JSON.stringify(journal));

  const dir = join(root, `old-${tag}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, DB_FILENAME);
  const sqlite = new Database(path);
  migrate(drizzle(sqlite), { migrationsFolder: migrations });
  sqlite.exec(
    "insert into repos (id, path, name, created_at, updated_at) values ('r1', '/code/app', 'app', 0, 0)",
  );
  sqlite.close();
  return path;
}

/** An archive around a database file, with a manifest at the database's own level. */
function archiveOf(path: string): Uint8Array {
  const sqlite = new Database(path, { readonly: true });
  const migration = migrationLevel(sqlite);
  sqlite.close();
  const manifest: DataManifest = {
    format: 1,
    app: "blackwall",
    blackwallVersion: "0.0.0",
    exportedAt: NOW.toISOString(),
    migration,
    includesTranscripts: true,
  };
  return zipSync({
    [MANIFEST_FILENAME]: strToU8(JSON.stringify(manifest)),
    [DB_FILENAME]: readFileSync(path),
  });
}

describe("readImportArchive", () => {
  it("migrates an older archive", () => {
    const path = databaseAt("0015_task_base_branch");
    const archive = readImportArchive(archiveOf(path));
    try {
      expect(archive.manifest.migration.tag).toBe("0015_task_base_branch");
      expect(archive.migrated).toBe(true);
      const db = new Database(archive.dbPath, { readonly: true });
      try {
        expect(migrationLevel(db).count).toBe(migrationJournal().length);
        expect(db.prepare("select default_branch from repos").pluck().get()).toBe("main");
      } finally {
        db.close();
      }
    } finally {
      archive.cleanup();
    }
    expect(existsSync(archive.dbPath)).toBe(false);
  });

  it("refuses an archive from a newer build", () => {
    const source = open("source");
    const last = migrationJournal().at(-1)!.when;
    source.sqlite
      .prepare("insert into __drizzle_migrations (hash, created_at) values ('future', ?)")
      .run(last + 1000);
    expect(() => readImportArchive(exportOf(source.sqlite))).toThrow(DataArchiveTooNewError);
  });

  it("refuses invalid archives", () => {
    const source = open("source");
    const { manifest, db } = archiveEntries(exportOf(source.sqlite));
    const json = (value: unknown) => strToU8(JSON.stringify(value));
    const cases: Uint8Array[] = [
      strToU8("not a zip"),
      zipSync({ [DB_FILENAME]: db }),
      zipSync({ [MANIFEST_FILENAME]: strToU8("{nope"), [DB_FILENAME]: db }),
      zipSync({ [MANIFEST_FILENAME]: json({ ...manifest, format: 2 }), [DB_FILENAME]: db }),
      zipSync({ [MANIFEST_FILENAME]: json(manifest) }),
      zipSync({
        [MANIFEST_FILENAME]: json({ ...manifest, migration: { ...manifest.migration, count: 3 } }),
        [DB_FILENAME]: db,
      }),
      zipSync({ [MANIFEST_FILENAME]: json(manifest), [DB_FILENAME]: strToU8("not sqlite") }),
    ];
    for (const bytes of cases) {
      expect(() => readImportArchive(bytes)).toThrow(InvalidDataArchiveError);
    }
  });
});

describe("restoreDatabase", () => {
  it("interrupts running and queued work and drops the usage-limit state", async () => {
    const source = open("source");
    const { repo, run, step } = await seed(source.r);
    const running = source.r.tasks.create({
      title: "Running",
      origin: { kind: "free-text" },
      repoId: repo.id,
      status: "running",
      delivering: true,
    });
    const queued = source.r.tasks.create({
      title: "Queued",
      origin: { kind: "free-text" },
      repoId: repo.id,
      status: "queued",
    });
    source.r.steps.update(step.id, { status: "running" });
    source.r.runs.setStatus(run.id, "running");
    source.r.settings.set(QUOTA_KEY, { claude: { until: NOW.toISOString() } });

    const target = open("target");
    const archive = readImportArchive(exportOf(source.sqlite));
    try {
      restoreDatabase(target.sqlite, archive.dbPath);
    } finally {
      archive.cleanup();
    }

    for (const id of [running.id, queued.id]) {
      expect(target.r.tasks.get(id)).toMatchObject({
        status: "interrupted",
        error: IMPORT_INTERRUPTED_ERROR,
        delivering: false,
      });
    }
    expect(target.r.steps.get(step.id)?.status).toBe("interrupted");
    expect(target.r.runs.get(run.id)?.status).toBe("interrupted");
    expect(target.r.settings.get(QUOTA_KEY)).toBeUndefined();
    expect(target.r.settings.get("maxTasksPerRepo")).toBe(2);
  });
});

describe("backupDatabase", () => {
  it("copies the live database into backups/", () => {
    const live = open("live");
    live.r.settings.set("maxTasksPerRepo", 4);
    const first = backupDatabase(live.sqlite, live.dir, NOW);
    const second = backupDatabase(live.sqlite, live.dir, NOW);
    expect(first.startsWith(join(live.dir, "backups", "blackwall-"))).toBe(true);
    expect(first).toMatch(/blackwall-\d{8}-\d{6}\.db$/);
    expect(second).not.toBe(first);
    const copy = new Database(first, { readonly: true });
    try {
      const value = copy
        .prepare("select value from settings where key = ?")
        .pluck()
        .get("maxTasksPerRepo");
      expect(value).toBe("4");
    } finally {
      copy.close();
    }
  });
});
