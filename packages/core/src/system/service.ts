import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SystemInfo, SystemTableStat } from "@blackwall/shared";
import { DB_FILENAME, MIGRATIONS_DIR, type Db } from "../db/database.js";
import type { Repositories } from "../db/repositories.js";
import { ARTIFACTS_DIR } from "../pipeline/artifacts.js";

/** Compacting rewrites the whole file, so it waits for running agents to finish. */
export class DatabaseBusyError extends Error {
  constructor() {
    super("Compacting waits until no task is running");
    this.name = "DatabaseBusyError";
  }
}

/** The system facts the core knows; the server adds `runtime`. */
export type SystemSnapshot = Omit<SystemInfo, "runtime">;

export interface SystemServiceOptions {
  /** The data directory, or `:memory:`. */
  dataDir: string;
  db: Db;
  tasks: Pick<Repositories["tasks"], "list">;
}

/** A file's size in bytes; 0 when it is missing. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Bytes and files under `root`. Never follows symlinks or junctions and skips
 * entries it cannot read; 0 for a missing folder.
 */
export async function directorySize(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const sizes = await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          return null;
        }
        if (!entry.isFile()) return null;
        return (await lstat(path).catch(() => null))?.size ?? null;
      }),
    );
    for (const size of sizes) {
      if (size === null) continue;
      bytes += size;
      files += 1;
    }
  }
  return { bytes, files };
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function readJournal(): { available: number; latest: string | null } {
  try {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as {
      entries: { tag: string }[];
    };
    return { available: journal.entries.length, latest: journal.entries.at(-1)?.tag ?? null };
  } catch {
    return { available: 0, latest: null };
  }
}

/**
 * What blackwall stores: database size per table, migrations, worktrees and
 * artifacts. The cheap stats come on every call; the worktree total, which
 * may walk `node_modules`, only when asked.
 */
export function createSystemService({ dataDir, db, tasks }: SystemServiceOptions) {
  const sqlite = db.$client;
  const path = dataDir === ":memory:" ? ":memory:" : join(dataDir, DB_FILENAME);

  function files() {
    if (path === ":memory:") return { fileBytes: 0, walBytes: 0, shmBytes: 0, totalBytes: 0 };
    const fileBytes = fileSize(path);
    const walBytes = fileSize(`${path}-wal`);
    const shmBytes = fileSize(`${path}-shm`);
    return { fileBytes, walBytes, shmBytes, totalBytes: fileBytes + walBytes + shmBytes };
  }

  /** Bytes per table, indexes included; null without the `dbstat` virtual table. */
  function tableBytes(): Map<string, number> | null {
    try {
      const rows = sqlite
        .prepare(
          `select m.tbl_name as name, sum(s.pgsize) as bytes
             from dbstat s join sqlite_master m on m.name = s.name
            group by m.tbl_name`,
        )
        .all() as { name: string; bytes: number }[];
      return new Map(rows.map((row) => [row.name, row.bytes]));
    } catch {
      return null;
    }
  }

  function tables(): { dbstat: boolean; tables: SystemTableStat[] } {
    const names = sqlite
      .prepare(
        `select name from sqlite_master
          where type = 'table' and name not glob 'sqlite_*' and name <> '__drizzle_migrations'`,
      )
      .pluck()
      .all() as string[];
    const bytes = tableBytes();
    const stats = names.map((name) => ({
      name,
      rows: sqlite
        .prepare(`select count(*) from ${quoteIdentifier(name)}`)
        .pluck()
        .get() as number,
      bytes: bytes ? (bytes.get(name) ?? 0) : null,
    }));
    stats.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.rows - a.rows);
    return { dbstat: bytes !== null, tables: stats };
  }

  function appliedMigrations(): number {
    try {
      return sqlite.prepare("select count(*) from __drizzle_migrations").pluck().get() as number;
    } catch {
      return 0;
    }
  }

  async function worktrees(worktreeSizes: boolean): Promise<SystemSnapshot["worktrees"]> {
    const paths = tasks
      .list()
      .map((task) => task.worktreePath)
      .filter((p): p is string => p !== null && existsSync(p));
    let artifactCount = 0;
    let artifactBytes = 0;
    let totalBytes: number | null = worktreeSizes ? 0 : null;
    for (const worktree of paths) {
      const artifacts = await directorySize(join(worktree, ARTIFACTS_DIR));
      artifactCount += artifacts.files;
      artifactBytes += artifacts.bytes;
      if (totalBytes !== null) totalBytes += (await directorySize(worktree)).bytes;
    }
    return { count: paths.length, artifactCount, artifactBytes, totalBytes };
  }

  async function snapshot({ worktreeSizes = false } = {}): Promise<SystemSnapshot> {
    return {
      dataDir,
      database: {
        path,
        ...files(),
        ...tables(),
        migrations: { applied: appliedMigrations(), ...readJournal() },
      },
      worktrees: await worktrees(worktreeSizes),
      runningTasks: tasks.list().filter((task) => task.status === "running").length,
    };
  }

  return {
    snapshot,

    /**
     * Rewrites the database without free pages and empties the WAL. Synchronous,
     * so nothing else touches the database meanwhile; refused while a task runs.
     */
    async compact(): Promise<{ info: SystemSnapshot; freedBytes: number }> {
      if (tasks.list().some((task) => task.status === "running")) throw new DatabaseBusyError();
      const before = files().totalBytes;
      sqlite.exec("VACUUM");
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      const info = await snapshot();
      return { info, freedBytes: Math.max(0, before - info.database.totalBytes) };
    },
  };
}

export type SystemService = ReturnType<typeof createSystemService>;
