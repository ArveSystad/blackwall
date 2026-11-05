import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  DB_FILENAME,
  applyConnectionPragmas,
  openDatabase,
  type OpenedDatabase,
} from "../db/database.js";
import * as schema from "../db/schema.js";

/** A fully migrated empty database, serialized once per module graph (test file). */
let template: Buffer | undefined;

function migratedTemplate(): Buffer {
  if (!template) {
    const opened = openDatabase(":memory:");
    try {
      template = opened.db.$client.serialize();
    } finally {
      opened.close();
    }
  }
  return template;
}

/**
 * A drop-in for {@link openDatabase} in tests: a fresh database copied from a
 * template migrated once, instead of running every migration per test. A
 * directory that already holds a database is reopened with `openDatabase`, so
 * a "restart" over the same data keeps it.
 */
export function openTestDatabase(dataDir: string): OpenedDatabase {
  let path = ":memory:";
  let sqlite: Database.Database;
  if (dataDir === ":memory:") {
    sqlite = new Database(migratedTemplate());
  } else {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, DB_FILENAME);
    if (existsSync(path)) return openDatabase(dataDir);
    writeFileSync(path, migratedTemplate());
    sqlite = new Database(path);
  }
  try {
    applyConnectionPragmas(sqlite);
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    return { db, path, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
