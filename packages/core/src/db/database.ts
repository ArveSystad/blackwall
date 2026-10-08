import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export const DB_FILENAME = "blackwall.db";

/** Generated SQL migrations, relative to this file in both `src/` and `dist/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: Db;
  /** Absolute path of the database file, or `:memory:`. */
  path: string;
  close(): void;
}

/** Data directory: `BLACKWALL_HOME` if set, else `~/.blackwall`. */
export function resolveDataDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.BLACKWALL_HOME || join(homedir(), ".blackwall");
}

/**
 * Opens (creating if needed) the SQLite database in `dataDir`, enables WAL and
 * foreign keys, and applies pending migrations. Safe to call on every startup.
 * Pass `":memory:"` for an in-memory database.
 */
export function openDatabase(dataDir: string): OpenedDatabase {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, DB_FILENAME);
  }

  const sqlite = new Database(path);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");

    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    return { db, path, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
