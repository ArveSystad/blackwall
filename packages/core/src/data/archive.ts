import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATA_ARCHIVE_FORMAT,
  IMPORT_INTERRUPTED_ERROR,
  dataManifestSchema,
  type DataManifest,
} from "@blackwall/shared";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { QUOTA_KEY } from "../agents/quota.js";
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

/**
 * Replaces every row of the live database with the rows of `srcPath` (at the
 * same migration level) in one transaction, so services reading through the
 * repositories see the imported data at once. Running and queued tasks become
 * `interrupted`, running steps and runs too, and the usage-limit state is
 * dropped so nothing resumes on its own.
 */
export function restoreDatabase(sqlite: Sqlite, srcPath: string): void {
  sqlite.prepare("ATTACH DATABASE ? AS src").run(srcPath);
  try {
    // Off outside the transaction (SQLite ignores it inside), so deletes don't cascade.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.transaction(() => {
      const tables = tableNames(sqlite, "main");
      if (tableNames(sqlite, "src").join() !== tables.join()) {
        throw new InvalidDataArchiveError("the database has other tables than this build");
      }
      for (const table of tables) {
        const columns = (
          sqlite.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as { name: string }[]
        )
          .map((c) => quote(c.name))
          .join(", ");
        sqlite.exec(`DELETE FROM main.${quote(table)}`);
        sqlite.exec(
          `INSERT INTO main.${quote(table)} (${columns}) SELECT ${columns} FROM src.${quote(table)}`,
        );
      }
      rebuildMemoryIndex(sqlite);
      sqlite
        .prepare(
          "UPDATE main.tasks SET status = 'interrupted', error = ?, delivering = 0 " +
            "WHERE status IN ('running', 'queued')",
        )
        .run(IMPORT_INTERRUPTED_ERROR);
      // No delivery runs here, as at startup.
      sqlite.exec("UPDATE main.tasks SET delivering = 0 WHERE delivering = 1");
      sqlite.exec("UPDATE main.steps SET status = 'interrupted' WHERE status = 'running'");
      sqlite.exec("UPDATE main.runs SET status = 'interrupted' WHERE status = 'running'");
      sqlite.prepare("DELETE FROM main.settings WHERE key = ?").run(QUOTA_KEY);
      const violations = sqlite.pragma("main.foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new InvalidDataArchiveError(`${violations.length} foreign key violation(s)`);
      }
    })();
  } finally {
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("DETACH DATABASE src");
  }
}
