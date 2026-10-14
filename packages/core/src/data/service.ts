import type { DataImportResult, ServerEvent } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import type { PipelineEngine } from "../pipeline/engine.js";
import type { ConnectionTokens } from "../secrets/tokens.js";
import {
  backupDatabase,
  blackwallVersion,
  createExportArchive,
  readImportArchive,
  restoreDatabase,
  type Sqlite,
} from "./archive.js";

export class DataImportBusyError extends Error {
  constructor(readonly titles: string[]) {
    super(
      `Tasks are running, queued or finishing (${titles.join(", ")}); ` +
        "wait for them or stop them before importing",
    );
    this.name = "DataImportBusyError";
  }
}

export interface DataServiceOptions {
  /** The live database handle; an import replaces its rows in place. */
  sqlite: Sqlite;
  /** Where `backups/` goes. */
  dataDir: string;
  repositories: {
    tasks: Pick<Repositories["tasks"], "list">;
    repos: Pick<Repositories["repos"], "list">;
  };
  pipeline: Pick<PipelineEngine, "activeTaskIds" | "queuedTaskIds">;
  tokens: Pick<ConnectionTokens, "refresh" | "list">;
  /** Stops work that would write while the rows are replaced (backlog runner, chat). */
  pause: () => Promise<void>;
  resume: () => void;
  publish: (event: ServerEvent) => void;
  version?: string;
  clock?: () => Date;
  pathExists?: (path: string) => boolean;
}

export type DataService = ReturnType<typeof createDataService>;

/**
 * Exports the database (without secrets) and imports an export in place,
 * refusing while any task runs, is queued or is delivering.
 */
export function createDataService({
  sqlite,
  dataDir,
  repositories: r,
  pipeline,
  tokens,
  pause,
  resume,
  publish,
  version = blackwallVersion(),
  clock = () => new Date(),
  pathExists = () => true,
}: DataServiceOptions) {
  function assertIdle(): void {
    const engineIds = new Set([...pipeline.activeTaskIds(), ...pipeline.queuedTaskIds()]);
    const busy = r.tasks
      .list()
      .filter(
        (t) =>
          t.status === "running" || t.status === "queued" || t.delivering || engineIds.has(t.id),
      );
    if (busy.length > 0 || engineIds.size > 0) {
      throw new DataImportBusyError(busy.length > 0 ? busy.map((t) => t.title) : [...engineIds]);
    }
  }

  return {
    export({ includeTranscripts }: { includeTranscripts: boolean }): Uint8Array {
      return createExportArchive(sqlite, { includeTranscripts, version, now: clock() });
    },

    /**
     * Validates the archive, backs up the current database, replaces every row
     * and reports what still needs the user: tokens, repo folders, worktrees.
     */
    async import(bytes: Uint8Array): Promise<DataImportResult> {
      const archive = readImportArchive(bytes);
      try {
        assertIdle();
        await pause();
        let backupPath: string;
        let restored = false;
        try {
          // Something may have started while pausing.
          assertIdle();
          backupPath = backupDatabase(sqlite, dataDir, clock());
          restoreDatabase(sqlite, archive.dbPath);
          restored = true;
          // Same ids as the export, so this machine's keychain may already hold the tokens.
          for (const connection of tokens.list()) await tokens.refresh(connection.id);
        } finally {
          resume();
          if (restored) publish({ type: "data.imported", payload: {} });
        }
        return {
          backupPath,
          manifest: archive.manifest,
          connectionsMissingToken: tokens.list().filter((c) => !c.hasToken),
          missingRepos: r.repos
            .list()
            .filter((repo) => !pathExists(repo.path))
            .map(({ id, name, path }) => ({ id, name, path })),
          tasksMissingWorktree: r.tasks
            .list()
            .flatMap((t) =>
              t.worktreePath && !pathExists(t.worktreePath)
                ? [{ id: t.id, title: t.title, path: t.worktreePath }]
                : [],
            ),
        };
      } finally {
        archive.cleanup();
      }
    },
  };
}
