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
import {
  IMPORT_INTERRUPTED_ERROR,
  type DataImportDecisions,
  type DataManifest,
} from "@blackwall/shared";
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
  DataImportDecisionsError,
  InvalidDataArchiveError,
  MANIFEST_FILENAME,
  MERGE_TABLES,
  TRANSCRIPT_EVENT_TYPES,
  backupDatabase,
  createExportArchive,
  mergeDatabase,
  migrationJournal,
  migrationLevel,
  previewRepoConflicts,
  readImportArchive,
  samePath,
  sqliteOf,
  type MergeResult,
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

/** Exports `source` and merges it into `target`. */
function mergeInto(
  target: { sqlite: Sqlite },
  source: { sqlite: Sqlite },
  decisions: DataImportDecisions = {},
): MergeResult {
  const archive = readImportArchive(exportOf(source.sqlite));
  try {
    return mergeDatabase(target.sqlite, archive.dbPath, decisions);
  } finally {
    archive.cleanup();
  }
}

/** Every id of a table, sorted. */
function ids(sqlite: Sqlite, table: string): string[] {
  return sqlite.prepare(`SELECT id FROM "${table}" ORDER BY id`).pluck().all() as string[];
}

describe("createExportArchive", () => {
  it("merges every table into an empty database without the token or settings", async () => {
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
      mergeDatabase(target.sqlite, archive.dbPath);
    } finally {
      archive.cleanup();
    }

    const expected = dump(source.sqlite);
    const actual = dump(target.sqlite);
    expected.connections = expected.connections!.map((c) => ({
      ...(c as object),
      token_set: 0,
    }));
    for (const table of MERGE_TABLES) {
      if (table === "repos") continue;
      expect(actual[table], table).toEqual(expected[table]);
    }
    expect(target.r.repos.list().map((r) => r.path)).toEqual(["/elsewhere", "/code/app"]);
    expect(actual.settings).toEqual([]);
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
    mergeInto(target, source);
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

describe("mergeDatabase", () => {
  it("interrupts imported running and queued work and keeps the local settings", async () => {
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

    source.r.settings.set("maxTasksPerRepo", 5);
    const target = open("target");
    const localQuota = { copilot: { until: NOW.toISOString() } };
    target.r.settings.set(QUOTA_KEY, localQuota);
    target.r.settings.set("maxTasksPerRepo", 3);
    mergeInto(target, source);

    for (const id of [running.id, queued.id]) {
      expect(target.r.tasks.get(id)).toMatchObject({
        status: "interrupted",
        error: IMPORT_INTERRUPTED_ERROR,
        delivering: false,
      });
    }
    expect(target.r.steps.get(step.id)?.status).toBe("interrupted");
    expect(target.r.runs.get(run.id)?.status).toBe("interrupted");
    expect(target.r.settings.get(QUOTA_KEY)).toEqual(localQuota);
    expect(target.r.settings.get("maxTasksPerRepo")).toBe(3);
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

/** A repo with a task, a memory and a repo chat message. */
function repoWithChildren(r: Repositories, path: string, remoteUrl: string | null, tag: string) {
  const repo = r.repos.create({ path, name: `repo-${tag}`, remoteUrl });
  const task = r.tasks.create({
    title: `Task ${tag}`,
    origin: { kind: "free-text" },
    repoId: repo.id,
    status: "done",
  });
  const memory = r.memories.create({ repoId: repo.id, kind: "pitfall", text: `Memory ${tag}` });
  const chat = r.chatMessages.insert({ repoId: repo.id, taskId: null, role: "user", text: tag });
  return { repo, task, memory, chat };
}

describe("mergeDatabase: union", () => {
  it("leaves both machines with everything after A to B and B to A", async () => {
    const a = open("a");
    await seed(a.r);
    const b = open("b");
    const lib = repoWithChildren(b.r, "/code/lib", "git@github.com:acme/lib.git", "b");
    b.r.memories.create({ repoId: lib.repo.id, kind: "pitfall", text: "Only on B" });

    mergeInto(b, a);
    mergeInto(a, b);

    for (const table of ["repos", "tasks", "runs", "steps", "memories", "chat_messages"]) {
      expect(ids(a.sqlite, table), table).toEqual(ids(b.sqlite, table));
    }
    expect(ids(a.sqlite, "repos")).toHaveLength(2);
    const texts = a.sqlite.prepare("SELECT text FROM memories").pluck().all() as string[];
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).toHaveLength(3);
  });

  it("imports nothing when the same archive is merged again", async () => {
    const source = open("source");
    await seed(source.r);
    const target = open("target");
    const first = mergeInto(target, source);
    const second = mergeInto(target, source);
    for (const [table, count] of Object.entries(second.counts)) {
      expect(count.imported, table).toBe(0);
      expect(count.skipped, table).toBe(
        first.counts[table as keyof MergeResult["counts"]].imported,
      );
    }
    expect(first.counts.tasks).toEqual({ imported: 1, skipped: 0 });
    expect(first.counts.stepEvents).toEqual({ imported: 5, skipped: 0 });
  });

  it("keeps local rows when they changed after an earlier import", async () => {
    const a = open("a");
    const { task } = await seed(a.r);
    const b = open("b");
    mergeInto(b, a);
    a.r.tasks.update(task.id, { title: "Renamed on A" });
    mergeInto(b, a);
    expect(b.r.tasks.get(task.id)?.title).toBe("Fix login");
  });

  it("matches agents and connections by name and remaps their references", async () => {
    const source = open("source");
    const { connection, repo, task, step } = await seed(source.r);
    const agent = source.r.agents.list()[0]!;
    source.r.findings.createMany([
      {
        taskId: task.id,
        severity: "low",
        title: "Nit",
        explanation: "Tidy",
        reviewerAgentId: agent.id,
      },
    ]);
    const pr = source.r.tasks.create({
      title: "Review PR",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/app/pull/1",
        owner: "acme",
        repo: "app",
        number: 1,
        connectionId: connection.id,
      },
      repoId: repo.id,
      agents: { planner: agent.id, codeReviewers: [agent.id] },
      agentClis: { [agent.id]: "copilot" },
    });

    const target = open("target");
    const localAgent = target.r.agents.create({ name: "Planner", prompt: "Local" });
    const localConn = target.r.connections.create({
      name: "github.com",
      kind: "github",
      baseUrl: "https://api.github.com",
    });
    const result = mergeInto(target, source);

    expect(result.counts.agents).toEqual({ imported: 0, skipped: 1 });
    expect(result.counts.connections).toEqual({ imported: 0, skipped: 1 });
    expect(target.r.steps.get(step.id)?.agentId).toBe(localAgent.id);
    const reviewers = target.sqlite
      .prepare("SELECT reviewer_agent_id FROM findings WHERE reviewer_agent_id IS NOT NULL")
      .pluck()
      .all();
    expect(reviewers).toEqual([localAgent.id]);
    expect(target.r.tasks.get(pr.id)).toMatchObject({
      agents: { planner: localAgent.id, codeReviewers: [localAgent.id] },
      agentClis: { [localAgent.id]: "copilot" },
      origin: { connectionId: localConn.id },
    });
    expect(target.r.repos.get(repo.id)?.connectionId).toBe(localConn.id);
  });

  it("skips a run whose number the task already has, with its steps", async () => {
    const a = open("a");
    const { task } = await seed(a.r);
    const b = open("b");
    mergeInto(b, a);
    const onA = a.r.runs.create(task.id);
    a.r.steps.create({ runId: onA.id, stage: "plan" });
    const onB = b.r.runs.create(task.id);
    expect(onB.number).toBe(onA.number);

    const result = mergeInto(b, a);
    expect(b.r.runs.get(onA.id)).toBeUndefined();
    expect(result.counts.runs).toEqual({ imported: 0, skipped: 2 });
    expect(result.counts.steps).toEqual({ imported: 0, skipped: 2 });
  });

  it("keeps merged-into links between imported findings", async () => {
    const source = open("source");
    const { task, run } = await seed(source.r);
    const [first, second] = source.r.findings.createMany([
      { taskId: task.id, runId: run.id, severity: "low", title: "A", explanation: "a" },
      { taskId: task.id, runId: run.id, severity: "low", title: "B", explanation: "b" },
    ]);
    source.sqlite
      .prepare("UPDATE findings SET merged_into_id = ? WHERE id = ?")
      .run(first!.id, second!.id);
    const target = open("target");
    mergeInto(target, source);
    const merged = target.sqlite
      .prepare("SELECT merged_into_id FROM findings WHERE id = ?")
      .pluck()
      .get(second!.id);
    expect(merged).toBe(first!.id);
  });

  it("covers every table but settings", () => {
    const fresh = open("fresh");
    const tables = Object.keys(dump(fresh.sqlite)).sort();
    expect([...MERGE_TABLES, "settings"].sort()).toEqual(tables);
  });
});

describe("mergeDatabase: repos", () => {
  it("maps a repo with the same remote and folder onto the local one", () => {
    const source = open("source");
    const s = repoWithChildren(source.r, "/code/app", "https://github.com/Acme/App.git", "s");
    const target = open("target");
    const local = target.r.repos.create({
      path: "/code/app",
      name: "app",
      remoteUrl: "git@github.com:acme/app",
    });

    const archive = readImportArchive(exportOf(source.sqlite));
    try {
      expect(previewRepoConflicts(target.sqlite, archive.dbPath)).toEqual([]);
    } finally {
      archive.cleanup();
    }
    const result = mergeInto(target, source);
    expect(ids(target.sqlite, "repos")).toEqual([local.id]);
    expect(target.r.tasks.get(s.task.id)?.repoId).toBe(local.id);
    expect(ids(target.sqlite, "memories")).toEqual([s.memory.id]);
    expect(result.matchedRepos).toEqual([
      {
        id: local.id,
        name: "app",
        path: "/code/app",
        remoteUrl: "git@github.com:acme/app",
        importedId: s.repo.id,
        importedName: "repo-s",
        importedPath: "/code/app",
        importedRemoteUrl: "https://github.com/Acme/App.git",
      },
    ]);
    expect(result.counts.repos).toEqual({ imported: 0, skipped: 1 });
  });

  for (const kind of ["different-path", "different-remote"] as const) {
    describe(kind, () => {
      function setup() {
        const source = open("source");
        const s = repoWithChildren(source.r, "/code/app", "https://github.com/acme/app", "s");
        const target = open("target");
        const local =
          kind === "different-path"
            ? target.r.repos.create({
                path: "/work/app",
                name: "app",
                remoteUrl: "git@github.com:acme/app.git",
              })
            : target.r.repos.create({
                path: "/code/app",
                name: "app",
                remoteUrl: "https://github.com/someone/else",
              });
        return { source, target, s, local };
      }

      it("is reported by the preview", () => {
        const { source, target, s, local } = setup();
        const archive = readImportArchive(exportOf(source.sqlite));
        try {
          expect(previewRepoConflicts(target.sqlite, archive.dbPath)).toEqual([
            expect.objectContaining({ kind, id: local.id, importedId: s.repo.id }),
          ]);
        } finally {
          archive.cleanup();
        }
      });

      it("refuses without a decision and changes nothing", () => {
        const { source, target } = setup();
        const before = dump(target.sqlite);
        expect(() => mergeInto(target, source)).toThrow(DataImportDecisionsError);
        expect(dump(target.sqlite)).toEqual(before);
      });

      it("merges the children into the local repo", () => {
        const { source, target, s, local } = setup();
        const result = mergeInto(target, source, { [s.repo.id]: "merge" });
        expect(ids(target.sqlite, "repos")).toEqual([local.id]);
        expect(target.r.tasks.get(s.task.id)?.repoId).toBe(local.id);
        expect(ids(target.sqlite, "memories")).toEqual([s.memory.id]);
        expect(target.r.chatMessages.list(local.id, null).map((m) => m.text)).toEqual(["s"]);
        expect(result.repoDecisions).toEqual([
          expect.objectContaining({ kind, importedId: s.repo.id, decision: "merge" }),
        ]);
      });

      it("skips the repo and everything under it", () => {
        const { source, target, s, local } = setup();
        const result = mergeInto(target, source, { [s.repo.id]: "skip" });
        expect(ids(target.sqlite, "repos")).toEqual([local.id]);
        expect(target.r.tasks.get(s.task.id)).toBeUndefined();
        expect(ids(target.sqlite, "memories")).toEqual([]);
        expect(ids(target.sqlite, "chat_messages")).toEqual([]);
        expect(result.counts.repos).toEqual({ imported: 0, skipped: 1 });
        expect(result.counts.tasks).toEqual({ imported: 0, skipped: 1 });
        expect(result.counts.memories).toEqual({ imported: 0, skipped: 1 });
        expect(result.counts.chatMessages).toEqual({ imported: 0, skipped: 1 });
        expect(result.repoDecisions).toEqual([expect.objectContaining({ kind, decision: "skip" })]);
      });
    });
  }

  it("maps a repo without a remote onto the local repo in the same folder", () => {
    const source = open("source");
    const s = repoWithChildren(source.r, "/code/app", null, "s");
    const target = open("target");
    const local = target.r.repos.create({
      path: "/code/app",
      name: "app",
      remoteUrl: "https://github.com/acme/app",
    });
    const result = mergeInto(target, source);
    expect(result.repoDecisions).toEqual([]);
    expect(target.r.tasks.get(s.task.id)?.repoId).toBe(local.id);
  });

  it("skips a memory the matched repo already has", () => {
    const source = open("source");
    repoWithChildren(source.r, "/code/app", "https://github.com/acme/app", "s");
    const target = open("target");
    const local = target.r.repos.create({
      path: "/code/app",
      name: "app",
      remoteUrl: "https://github.com/acme/app",
    });
    const kept = target.r.memories.create({ repoId: local.id, kind: "pitfall", text: "Memory s" });
    const result = mergeInto(target, source);
    expect(result.counts.memories).toEqual({ imported: 0, skipped: 1 });
    expect(ids(target.sqlite, "memories")).toEqual([kept.id]);
  });
});

describe("samePath", () => {
  it("ignores case and trailing separators on Windows only", () => {
    expect(samePath("C:/Code/App", "c:/code/app/", "win32")).toBe(true);
    expect(samePath("/code/App", "/code/app", "linux")).toBe(false);
    expect(samePath("/code/app/", "/code/app", "linux")).toBe(true);
  });
});
