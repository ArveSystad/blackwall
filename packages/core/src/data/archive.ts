import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_ARCHIVE_FORMAT,
  DATA_IMPORT_TABLES,
  IMPORT_INTERRUPTED_ERROR,
  dataManifestSchema,
  remoteKey,
  type AgentClis,
  type DataImportCount,
  type DataImportDecisions,
  type DataImportTable,
  type DataManifest,
  type FollowUp,
  type ImportedRepoMatch,
  type RepoConflict,
  type RepoDecision,
  type RoleAgents,
  type TaskOrigin,
} from "@blackwall/shared";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { DB_FILENAME, MIGRATIONS_DIR, openDatabase, type Db } from "../db/database.js";

export type Sqlite = Database.Database;

/** The better-sqlite3 handle under a Drizzle database. */
export function sqliteOf(db: Db): Sqlite {
  return (db as Db & { $client: Sqlite }).$client;
}

export const MANIFEST_FILENAME = "manifest.json";
/** Backups of the database taken before an import, in the data dir. */
export const BACKUPS_DIRNAME = "backups";

/**
 * Step event types that make up an agent's transcript, left out of a light
 * export. Every other type is pipeline state (`result`, `delivery.*`,
 * `review.diff`, `check.*`, …) that the engine reads back, and must stay.
 */
export const TRANSCRIPT_EVENT_TYPES = [
  "message",
  "tool-call-start",
  "tool-call-end",
  "subagent-start",
  "subagent-end",
] as const;

export class InvalidDataArchiveError extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`Not a valid blackwall export: ${reason}`, options);
    this.name = "InvalidDataArchiveError";
  }
}

export class DataArchiveTooNewError extends Error {
  constructor() {
    super("The export comes from a newer blackwall; update blackwall before importing it");
    this.name = "DataArchiveTooNewError";
  }
}

const PACKAGE_JSON = fileURLToPath(new URL("../../package.json", import.meta.url));

/** The version recorded in a manifest; informational only. */
export function blackwallVersion(): string {
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version?: string };
  return version ?? "0.0.0";
}

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

/** This build's migrations, in order. */
export function migrationJournal(): JournalEntry[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries;
}

export type MigrationLevel = DataManifest["migration"];

/** Applied migration rows' `created_at`, which drizzle sets to the journal entry's `when`. */
function appliedMigrations(sqlite: Sqlite): number[] {
  return sqlite
    .prepare("SELECT created_at FROM __drizzle_migrations ORDER BY created_at")
    .pluck()
    .all() as number[];
}

/** How far a database is migrated: the count and the last applied journal entry. */
export function migrationLevel(sqlite: Sqlite): MigrationLevel {
  const applied = appliedMigrations(sqlite);
  const when = applied.at(-1) ?? 0;
  const tag = migrationJournal().find((e) => e.when === when)?.tag ?? null;
  return { count: applied.length, tag, when };
}

/** `yyyyMMdd-HHmmss` in local time, for export and backup file names. */
export function dataStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "blackwall-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ExportOptions {
  includeTranscripts: boolean;
  version: string;
  now: Date;
}

/**
 * A zip of the manifest and a consistent copy of the database. Connections
 * keep their name, URL and auth metadata but lose `token_set`; tokens live in
 * the keychain and are never read here.
 */
export function createExportArchive(
  sqlite: Sqlite,
  { includeTranscripts, version, now }: ExportOptions,
): Uint8Array {
  return withTempDir((dir) => {
    const path = join(dir, DB_FILENAME);
    // Synchronous on the live handle, so no write lands halfway through the snapshot.
    sqlite.prepare("VACUUM INTO ?").run(path);
    const copy = new Database(path);
    let migration: MigrationLevel;
    try {
      copy.exec("UPDATE connections SET token_set = 0");
      if (!includeTranscripts) {
        copy
          .prepare(
            `DELETE FROM step_events WHERE type IN (${TRANSCRIPT_EVENT_TYPES.map(() => "?").join(", ")})`,
          )
          .run(...TRANSCRIPT_EVENT_TYPES);
      }
      migration = migrationLevel(copy);
      copy.pragma("journal_mode = DELETE");
      copy.exec("VACUUM");
    } finally {
      copy.close();
    }
    const manifest: DataManifest = {
      format: DATA_ARCHIVE_FORMAT,
      app: "blackwall",
      blackwallVersion: version,
      exportedAt: now.toISOString(),
      migration,
      includesTranscripts: includeTranscripts,
    };
    return zipSync({
      [MANIFEST_FILENAME]: strToU8(JSON.stringify(manifest, null, 2)),
      [DB_FILENAME]: readFileSync(path),
    });
  });
}

export interface ImportArchive {
  manifest: DataManifest;
  /** The archive's database, migrated to this build's level. */
  dbPath: string;
  /** Whether the archive was at an older migration level. */
  migrated: boolean;
  /** Removes the temp copy. */
  cleanup(): void;
}

function readManifest(bytes: Uint8Array | undefined): DataManifest {
  if (!bytes) throw new InvalidDataArchiveError(`${MANIFEST_FILENAME} is missing`);
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch (error) {
    throw new InvalidDataArchiveError(`${MANIFEST_FILENAME} is not JSON`, { cause: error });
  }
  const parsed = dataManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidDataArchiveError(`${MANIFEST_FILENAME} is not a blackwall manifest`);
  }
  return parsed.data;
}

/** Throws unless the database's own migration level matches the manifest and this build knows it. */
function checkLevel(path: string, manifest: DataManifest): MigrationLevel {
  let sqlite: Sqlite | undefined;
  let level: MigrationLevel;
  let applied: number[];
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    level = migrationLevel(sqlite);
    applied = appliedMigrations(sqlite);
  } catch (error) {
    throw new InvalidDataArchiveError(`${DB_FILENAME} is not a blackwall database`, {
      cause: error,
    });
  } finally {
    sqlite?.close();
  }
  if (level.count !== manifest.migration.count || level.when !== manifest.migration.when) {
    throw new InvalidDataArchiveError("the database does not match its manifest");
  }
  // Drizzle's migrate skips rows it does not know, so a newer database would pass unnoticed.
  const journal = migrationJournal();
  const known = new Set(journal.map((e) => e.when));
  const last = journal.at(-1)?.when ?? 0;
  if (applied.some((when) => !known.has(when) || when > last)) throw new DataArchiveTooNewError();
  return level;
}

/**
 * Unzips and checks an export: both entries, a valid manifest, a database at
 * the manifest's migration level and not newer than this build. The database
 * is migrated in a temp dir and must pass the foreign key and integrity checks.
 */
export function readImportArchive(bytes: Uint8Array): ImportArchive {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new InvalidDataArchiveError("not a zip file", { cause: error });
  }
  const manifest = readManifest(entries[MANIFEST_FILENAME]);
  const db = entries[DB_FILENAME];
  if (!db) throw new InvalidDataArchiveError(`${DB_FILENAME} is missing`);

  const dir = mkdtempSync(join(tmpdir(), "blackwall-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const dbPath = join(dir, DB_FILENAME);
    writeFileSync(dbPath, db);
    const level = checkLevel(dbPath, manifest);
    let opened;
    try {
      opened = openDatabase(dir);
    } catch (error) {
      throw new InvalidDataArchiveError("the database could not be migrated", { cause: error });
    }
    try {
      rebuildMemoryIndex(sqliteOf(opened.db));
      const integrity = sqliteOf(opened.db).pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new InvalidDataArchiveError("the database is corrupt");
    } finally {
      opened.close();
    }
    return {
      manifest,
      dbPath,
      migrated: level.count < migrationJournal().length,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Copies the live database to `<dataDir>/backups/blackwall-<stamp>.db`; returns the path. */
export function backupDatabase(sqlite: Sqlite, dataDir: string, now: Date): string {
  const dir = join(dataDir, BACKUPS_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const base = `${DB_FILENAME.replace(/\.db$/, "")}-${dataStamp(now)}`;
  let path = join(dir, `${base}.db`);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${base}-${n}.db`);
  sqlite.prepare("VACUUM INTO ?").run(path);
  return path;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function tableNames(sqlite: Sqlite, schema: "main" | "src"): string[] {
  return sqlite
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' ` +
        `AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ` +
        // The full-text index and its shadow tables are rebuilt from `memories`.
        `AND name NOT LIKE 'memories_fts%' ORDER BY name`,
    )
    .pluck()
    .all() as string[];
}

/**
 * Rebuilds the memories' full-text index from the table. The index joins on
 * `memories.rowid`, which a copy or `VACUUM` may renumber.
 */
export function rebuildMemoryIndex(sqlite: Sqlite, schema: "main" | "src" = "main"): void {
  sqlite.exec(`INSERT INTO ${schema}.memories_fts(memories_fts) VALUES('rebuild')`);
}

/** Imported repos the user has not decided on (merge or skip); nothing was written. */
export class DataImportDecisionsError extends Error {
  constructor(readonly conflicts: RepoConflict[]) {
    super(
      "Repositories changed since the check; pick the file again " +
        `(undecided: ${conflicts.map((c) => c.importedName).join(", ")})`,
    );
    this.name = "DataImportDecisionsError";
  }
}

/** Tables a merge fills, parents before children. `settings` is never imported. */
export const MERGE_TABLES = [
  "connections",
  "agents",
  "tags",
  "repos",
  "tasks",
  "backlog_items",
  "chat_messages",
  "runs",
  "steps",
  "step_events",
  "findings",
  "grill_questions",
  "memories",
] as const;
type MergeTable = (typeof MERGE_TABLES)[number];

const COUNT_KEYS: Record<MergeTable, DataImportTable> = {
  connections: "connections",
  agents: "agents",
  tags: "tags",
  repos: "repos",
  tasks: "tasks",
  backlog_items: "backlogItems",
  chat_messages: "chatMessages",
  runs: "runs",
  steps: "steps",
  step_events: "stepEvents",
  findings: "findings",
  grill_questions: "grillQuestions",
  memories: "memories",
};

/** Whether two folder paths are the same folder; case-insensitive on Windows. */
export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const lib = platform === "win32" ? win32 : posix;
  const norm = (p: string) => {
    const resolved = lib.resolve(p);
    const root = lib.parse(resolved).root;
    const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

interface RepoRow {
  id: string;
  name: string;
  path: string;
  remote_url: string | null;
  remote_key: string | null;
  created_at: number;
}

export interface RepoMatch {
  /** Imported repo id to local repo id, for repos mapped without asking. */
  resolved: Map<string, string>;
  /** Mapped by remote and folder onto a local repo with another id. */
  matched: ImportedRepoMatch[];
  /** Repos the user must merge or skip. */
  conflicts: RepoConflict[];
  /** Imported repo ids that are new here. */
  toInsert: string[];
}

function repoRows(sqlite: Sqlite, schema: "main" | "src"): RepoRow[] {
  return (
    sqlite
      .prepare(
        `SELECT id, name, path, remote_url, remote_key, created_at FROM ${schema}.repos ORDER BY rowid`,
      )
      .all() as RepoRow[]
  ).map((r) => ({ ...r, remote_key: r.remote_key ?? remoteKey(r.remote_url) }));
}

function describeMatch(local: RepoRow, imported: RepoRow): ImportedRepoMatch {
  return {
    id: local.id,
    name: local.name,
    path: local.path,
    remoteUrl: local.remote_url,
    importedId: imported.id,
    importedName: imported.name,
    importedPath: imported.path,
    importedRemoteUrl: imported.remote_url,
  };
}

/**
 * Maps each repo of the attached `src` database onto the live ones: same id,
 * then same remote (and folder), then same folder when either has no remote.
 * A remote match in another folder, or a folder match with another remote, is
 * a conflict the user decides.
 */
export function matchRepos(sqlite: Sqlite): RepoMatch {
  const locals = repoRows(sqlite, "main");
  const localIds = new Set(locals.map((l) => l.id));
  const result: RepoMatch = { resolved: new Map(), matched: [], conflicts: [], toInsert: [] };
  for (const imported of repoRows(sqlite, "src")) {
    if (localIds.has(imported.id)) {
      result.resolved.set(imported.id, imported.id);
      continue;
    }
    const byRemote = imported.remote_key
      ? locals.filter((l) => l.remote_key === imported.remote_key)
      : [];
    if (byRemote.length > 0) {
      const here = byRemote.find((l) => samePath(l.path, imported.path));
      if (here) {
        result.resolved.set(imported.id, here.id);
        result.matched.push(describeMatch(here, imported));
      } else {
        const oldest = byRemote.reduce((a, b) => (b.created_at < a.created_at ? b : a));
        result.conflicts.push({ ...describeMatch(oldest, imported), kind: "different-path" });
      }
      continue;
    }
    const atPath = locals.find((l) => samePath(l.path, imported.path));
    if (!atPath) result.toInsert.push(imported.id);
    else if (atPath.remote_key === null || imported.remote_key === null) {
      result.resolved.set(imported.id, atPath.id);
    } else {
      result.conflicts.push({ ...describeMatch(atPath, imported), kind: "different-remote" });
    }
  }
  return result;
}

function withSource<T>(sqlite: Sqlite, srcPath: string, fn: () => T): T {
  sqlite.prepare("ATTACH DATABASE ? AS src").run(srcPath);
  try {
    return fn();
  } finally {
    sqlite.exec("DETACH DATABASE src");
  }
}

function undecided(conflicts: RepoConflict[], decisions: DataImportDecisions): RepoConflict[] {
  return conflicts.filter((c) => decisions[c.importedId] === undefined);
}

/** The repos of `srcPath` that need the user's decision before an import. Reads only. */
export function previewRepoConflicts(sqlite: Sqlite, srcPath: string): RepoConflict[] {
  return withSource(sqlite, srcPath, () => matchRepos(sqlite).conflicts);
}

/** Throws {@link DataImportDecisionsError} unless every repo conflict has a decision. */
export function assertDecided(
  sqlite: Sqlite,
  srcPath: string,
  decisions: DataImportDecisions,
): void {
  const open = withSource(sqlite, srcPath, () =>
    undecided(matchRepos(sqlite).conflicts, decisions),
  );
  if (open.length > 0) throw new DataImportDecisionsError(open);
}

export interface MergeResult {
  counts: Record<DataImportTable, DataImportCount>;
  matchedRepos: ImportedRepoMatch[];
  repoDecisions: (RepoConflict & { decision: RepoDecision })[];
}

type Row = Record<string, unknown>;
type IdMap = ReadonlyMap<string, string>;

const parse = <T>(value: unknown): T => JSON.parse(value as string) as T;

export function mapRoleAgents(agents: RoleAgents, agentMap: IdMap): RoleAgents {
  const one = (id: string) => agentMap.get(id) ?? id;
  return Object.fromEntries(
    Object.entries(agents).map(([role, value]) => [
      role,
      Array.isArray(value) ? value.map(one) : typeof value === "string" ? one(value) : value,
    ]),
  ) as RoleAgents;
}

export function mapAgentClis(clis: AgentClis, agentMap: IdMap): AgentClis {
  return Object.fromEntries(Object.entries(clis).map(([id, cli]) => [agentMap.get(id) ?? id, cli]));
}

export function mapOrigin(origin: TaskOrigin, connMap: IdMap): TaskOrigin {
  if (!("connectionId" in origin) || origin.connectionId === null) return origin;
  return { ...origin, connectionId: connMap.get(origin.connectionId) ?? origin.connectionId };
}

/** Repo ids mapped to this machine; ids of repos that were not imported are dropped. */
export function mapRepoIds(ids: string[], repoMap: IdMap): string[] {
  return [...new Set(ids.flatMap((id) => repoMap.get(id) ?? []))];
}

export function mapFollowUps(followUps: FollowUp[], repoMap: IdMap): FollowUp[] {
  return followUps.map((f) =>
    f.repoId === null ? f : { ...f, repoId: repoMap.get(f.repoId) ?? f.repoId },
  );
}

/**
 * Merges the rows of `srcPath` (at the same migration level) into the live
 * database in one transaction, so services reading through the repositories
 * see them at once. Rows already here win: only new rows are added, and rows
 * under a repo the user skipped, or under a parent that was not imported, are
 * left out. Repos map by {@link matchRepos} and the `decisions`, connections
 * and agents by id, then name. Imported running and queued tasks become
 * `interrupted`, running steps and runs too, so nothing resumes on its own.
 * Settings (and the usage-limit state) are never imported.
 */
export function mergeDatabase(
  sqlite: Sqlite,
  srcPath: string,
  decisions: DataImportDecisions = {},
): MergeResult {
  return withSource(sqlite, srcPath, () => {
    try {
      return sqlite.transaction(() => mergeAttached(sqlite, decisions))();
    } catch (error) {
      if (error instanceof Database.SqliteError && error.code.startsWith("SQLITE_CONSTRAINT")) {
        throw new InvalidDataArchiveError(error.message, { cause: error });
      }
      throw error;
    }
  });
}

function mergeAttached(sqlite: Sqlite, decisions: DataImportDecisions): MergeResult {
  const tables = tableNames(sqlite, "main");
  if (tableNames(sqlite, "src").join() !== tables.join()) {
    throw new InvalidDataArchiveError("the database has other tables than this build");
  }
  const known = new Set<string>([...MERGE_TABLES, "settings"]);
  const unknown = tables.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new InvalidDataArchiveError(`this build cannot merge ${unknown.join(", ")}`);
  }

  const match = matchRepos(sqlite);
  const open = undecided(match.conflicts, decisions);
  if (open.length > 0) throw new DataImportDecisionsError(open);

  const counts = Object.fromEntries(
    DATA_IMPORT_TABLES.map((t) => [t, { imported: 0, skipped: 0 }]),
  ) as Record<DataImportTable, DataImportCount>;
  const skip = (table: MergeTable) => counts[COUNT_KEYS[table]].skipped++;
  const rows = (table: MergeTable) =>
    sqlite.prepare(`SELECT * FROM src.${quote(table)} ORDER BY rowid`).all() as Row[];
  const columns = (table: MergeTable) =>
    (sqlite.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
  const inserter = (table: MergeTable) => {
    const cols = columns(table);
    const stmt = sqlite.prepare(
      `INSERT INTO main.${quote(table)} (${cols.map(quote).join(", ")}) ` +
        `VALUES (${cols.map(() => "?").join(", ")})`,
    );
    return (row: Row) => {
      stmt.run(cols.map((c) => row[c] ?? null));
      counts[COUNT_KEYS[table]].imported++;
    };
  };
  const existsStmts = new Map<MergeTable, Database.Statement>();
  const exists = (table: MergeTable, id: unknown): boolean => {
    let stmt = existsStmts.get(table);
    if (!stmt) {
      stmt = sqlite.prepare(`SELECT 1 FROM main.${quote(table)} WHERE id = ?`).pluck();
      existsStmts.set(table, stmt);
    }
    return stmt.get(id) !== undefined;
  };
  const presentOrNull = (table: MergeTable, id: unknown) =>
    id !== null && exists(table, id) ? id : null;

  /** Connections and agents: same id, else same name, else new. */
  const mapByIdOrName = (table: "connections" | "agents"): Map<string, string> => {
    const map = new Map<string, string>();
    const byName = new Map(
      (sqlite.prepare(`SELECT name, id FROM main.${table}`).raw().all() as [string, string][]).map(
        ([name, id]) => [name, id],
      ),
    );
    const insert = inserter(table);
    for (const row of rows(table)) {
      const id = row.id as string;
      const local = exists(table, id) ? id : byName.get(row.name as string);
      if (local !== undefined) {
        map.set(id, local);
        skip(table);
      } else {
        insert(row);
        map.set(id, id);
      }
    }
    return map;
  };
  const connMap = mapByIdOrName("connections");
  const agentMap = mapByIdOrName("agents");
  const agentOrNull = (id: unknown) => (id === null ? null : (agentMap.get(id as string) ?? null));

  const insertTag = inserter("tags");
  const hasTag = sqlite.prepare("SELECT 1 FROM main.tags WHERE name = ?").pluck();
  for (const row of rows("tags")) {
    if (hasTag.get(row.name) === undefined) insertTag(row);
    else skip("tags");
  }

  // Repos: the whole map first, so reference ids can point at repos inserted later.
  const repoMap = new Map(match.resolved);
  const repoDecisions = match.conflicts.map((c) => {
    const decision = decisions[c.importedId]!;
    if (decision === "merge") repoMap.set(c.importedId, c.id);
    return { ...c, decision };
  });
  const toInsert = new Set(match.toInsert);
  for (const id of toInsert) repoMap.set(id, id);
  let position =
    (sqlite.prepare("SELECT COALESCE(MAX(position), -1) FROM main.repos").pluck().get() as number) +
    1;
  const insertRepo = inserter("repos");
  for (const row of rows("repos")) {
    if (!toInsert.has(row.id as string)) {
      skip("repos");
      continue;
    }
    insertRepo({
      ...row,
      connection_id:
        row.connection_id === null ? null : (connMap.get(row.connection_id as string) ?? null),
      reference_repo_ids: JSON.stringify(mapRepoIds(parse(row.reference_repo_ids), repoMap)),
      remote_key: remoteKey(row.remote_url as string | null),
      position: position++,
    });
  }
  const mappedRepo = (id: unknown) => repoMap.get(id as string);

  const insertTask = inserter("tasks");
  for (const row of rows("tasks")) {
    const repoId = mappedRepo(row.repo_id);
    if (exists("tasks", row.id) || repoId === undefined) {
      skip("tasks");
      continue;
    }
    const interrupted = row.status === "running" || row.status === "queued";
    insertTask({
      ...row,
      repo_id: repoId,
      origin: JSON.stringify(mapOrigin(parse(row.origin), connMap)),
      agents: JSON.stringify(mapRoleAgents(parse(row.agents), agentMap)),
      agent_clis: JSON.stringify(mapAgentClis(parse(row.agent_clis), agentMap)),
      reference_repo_ids: JSON.stringify(mapRepoIds(parse(row.reference_repo_ids), repoMap)),
      follow_ups: JSON.stringify(mapFollowUps(parse(row.follow_ups), repoMap)),
      // No delivery runs here, as at startup.
      delivering: 0,
      ...(interrupted ? { status: "interrupted", error: IMPORT_INTERRUPTED_ERROR } : {}),
    });
  }

  const insertBacklog = inserter("backlog_items");
  for (const row of rows("backlog_items")) {
    const repoId = mappedRepo(row.repo_id);
    if (exists("backlog_items", row.id) || repoId === undefined) {
      skip("backlog_items");
      continue;
    }
    insertBacklog({
      ...row,
      repo_id: repoId,
      origin: JSON.stringify(mapOrigin(parse(row.origin), connMap)),
      agents: JSON.stringify(mapRoleAgents(parse(row.agents), agentMap)),
      agent_clis: JSON.stringify(mapAgentClis(parse(row.agent_clis), agentMap)),
      reference_repo_ids:
        row.reference_repo_ids === null
          ? null
          : JSON.stringify(mapRepoIds(parse(row.reference_repo_ids), repoMap)),
      task_id: presentOrNull("tasks", row.task_id),
      source_task_id: presentOrNull("tasks", row.source_task_id),
    });
  }

  const insertChat = inserter("chat_messages");
  for (const row of rows("chat_messages")) {
    const repoId = mappedRepo(row.repo_id);
    if (
      exists("chat_messages", row.id) ||
      repoId === undefined ||
      (row.task_id !== null && !exists("tasks", row.task_id))
    ) {
      skip("chat_messages");
      continue;
    }
    insertChat({ ...row, repo_id: repoId });
  }

  const insertRun = inserter("runs");
  const runNumberTaken = sqlite
    .prepare("SELECT 1 FROM main.runs WHERE task_id = ? AND number = ?")
    .pluck();
  for (const row of rows("runs")) {
    if (
      exists("runs", row.id) ||
      !exists("tasks", row.task_id) ||
      runNumberTaken.get(row.task_id, row.number) !== undefined
    ) {
      skip("runs");
      continue;
    }
    insertRun({ ...row, status: row.status === "running" ? "interrupted" : row.status });
  }

  const insertStep = inserter("steps");
  for (const row of rows("steps")) {
    if (exists("steps", row.id) || !exists("runs", row.run_id)) {
      skip("steps");
      continue;
    }
    insertStep({
      ...row,
      agent_id: agentOrNull(row.agent_id),
      status: row.status === "running" ? "interrupted" : row.status,
    });
  }

  const eventCols = columns("step_events").map(quote).join(", ");
  const eventsImported = sqlite
    .prepare(
      `INSERT INTO main.step_events (${eventCols}) SELECT ${eventCols} FROM src.step_events s ` +
        "WHERE EXISTS (SELECT 1 FROM main.steps WHERE id = s.step_id) " +
        "AND NOT EXISTS (SELECT 1 FROM main.step_events e WHERE e.step_id = s.step_id AND e.seq = s.seq)",
    )
    .run().changes;
  const eventsTotal = sqlite
    .prepare("SELECT COUNT(*) FROM src.step_events")
    .pluck()
    .get() as number;
  counts.stepEvents = { imported: eventsImported, skipped: eventsTotal - eventsImported };

  /** Findings and grill questions: under a task (and run) that is here. */
  const underTask = (table: "findings" | "grill_questions", row: Row) =>
    !exists(table, row.id) &&
    exists("tasks", row.task_id) &&
    (row.run_id === null || exists("runs", row.run_id));

  const insertFinding = inserter("findings");
  const mergedInto: [string, string][] = [];
  for (const row of rows("findings")) {
    if (!underTask("findings", row)) {
      skip("findings");
      continue;
    }
    insertFinding({
      ...row,
      step_id: presentOrNull("steps", row.step_id),
      reviewer_agent_id: agentOrNull(row.reviewer_agent_id),
      merged_into_id: null,
    });
    if (row.merged_into_id !== null)
      mergedInto.push([row.id as string, row.merged_into_id as string]);
  }
  const setMergedInto = sqlite.prepare("UPDATE main.findings SET merged_into_id = ? WHERE id = ?");
  for (const [id, target] of mergedInto) {
    if (exists("findings", target)) setMergedInto.run(target, id);
  }

  const insertQuestion = inserter("grill_questions");
  for (const row of rows("grill_questions")) {
    if (!underTask("grill_questions", row)) {
      skip("grill_questions");
      continue;
    }
    insertQuestion({
      ...row,
      step_id: presentOrNull("steps", row.step_id),
      asked_by_agent_id: agentOrNull(row.asked_by_agent_id),
    });
  }

  const insertMemory = inserter("memories");
  const sameMemory = sqlite
    .prepare("SELECT 1 FROM main.memories WHERE repo_id = ? AND kind = ? AND text = ?")
    .pluck();
  for (const row of rows("memories")) {
    const repoId = mappedRepo(row.repo_id);
    if (
      exists("memories", row.id) ||
      repoId === undefined ||
      sameMemory.get(repoId, row.kind, row.text) !== undefined
    ) {
      skip("memories");
      continue;
    }
    insertMemory({
      ...row,
      repo_id: repoId,
      source_task_id: presentOrNull("tasks", row.source_task_id),
    });
  }
  rebuildMemoryIndex(sqlite);

  const violations = sqlite.pragma("main.foreign_key_check") as unknown[];
  if (violations.length > 0) {
    throw new InvalidDataArchiveError(`${violations.length} foreign key violation(s)`);
  }
  return { counts, matchedRepos: match.matched, repoDecisions };
}
