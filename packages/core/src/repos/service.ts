import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  repoInputSchema,
  repoScanInputSchema,
  repoUpdateSchema,
  type Repo,
  type RepoInput,
  type RepoScanInput,
  type RepoScanResult,
  type RepoUpdate,
  type RepoView,
} from "@blackwall/shared";
import type { ConnectionService } from "../connections/service.js";
import type { Repositories } from "../db/repositories.js";
import { suggestCheckCommands } from "./checks.js";
import { gitDirKind, readOriginRemote } from "./git.js";
import { findGitRepos } from "./scan.js";

/** Rejected repo input (not a folder, not a git repo, already registered). Safe to show the user. */
export class InvalidRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRepoError";
  }
}

export class RepoNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Repo ${id} not found`);
    this.name = "RepoNotFoundError";
  }
}

/** The repo still has tasks, so it cannot be removed from the registry. */
export class RepoInUseError extends Error {
  constructor(readonly repo: Repo) {
    super(`${repo.name} still has tasks; delete them first`);
    this.name = "RepoInUseError";
  }
}

/**
 * A registered repo's folder is gone. The repo has been removed from the
 * registry unless tasks still reference it (`removed` is then false).
 */
export class StaleRepoError extends Error {
  constructor(
    readonly repo: Repo,
    readonly removed: boolean,
  ) {
    super(
      removed
        ? `${repo.name} no longer exists at ${repo.path} and was removed from the registry`
        : `${repo.name} no longer exists at ${repo.path}; delete its tasks to remove it`,
    );
    this.name = "StaleRepoError";
  }
}

export interface RepoServiceOptions {
  repos: Repositories["repos"];
  connections: Pick<ConnectionService, "resolve">;
}

export type RepoService = ReturnType<typeof createRepoService>;

function invalid(error: { issues: readonly { message: string }[] }): InvalidRepoError {
  return new InvalidRepoError(error.issues.map((issue) => issue.message).join("; "));
}

/** Canonical absolute path of an existing folder (real case and separators on Windows). */
async function canonicalFolder(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new InvalidRepoError(`${path} is not an absolute path`);
  try {
    const real = await realpath(path);
    if ((await stat(real)).isDirectory()) return real;
  } catch {
    // Falls through to the error below.
  }
  throw new InvalidRepoError(`${path} is not a folder`);
}

/**
 * The repo registry: the local git repos the tool may work on. Each repo keeps
 * its `origin` remote, the GitHub connection resolved from it, and the check
 * commands the Checks stage runs.
 */
export function createRepoService({ repos, connections }: RepoServiceOptions) {
  function existing(id: string): Repo {
    const repo = repos.get(id);
    if (!repo) throw new RepoNotFoundError(id);
    return repo;
  }

  /** GitHub connection for a remote; `null` without a remote, a readable host or a connection. */
  function connectionIdFor(remoteUrl: string | null): string | null {
    if (!remoteUrl) return null;
    try {
      return connections.resolve({ kind: "github", remote: remoteUrl })?.id ?? null;
    } catch {
      return null; // e.g. a local-path remote
    }
  }

  /** Registers a canonical repo path; the caller has checked it is a repo and not registered. */
  async function register(
    path: string,
    fields: { name?: string | undefined; checkCommands?: string[] | undefined } = {},
  ): Promise<Repo> {
    const remoteUrl = await readOriginRemote(path);
    return repos.create({
      path,
      name: fields.name ?? basename(path),
      remoteUrl,
      connectionId: connectionIdFor(remoteUrl),
      checkCommands: fields.checkCommands ?? (await suggestCheckCommands(path)),
    });
  }

  /**
   * The repo, if its folder still exists. A repo whose folder is gone is removed
   * from the registry (when no task references it) and `StaleRepoError` is thrown.
   */
  function use(id: string): Repo {
    const repo = existing(id);
    if (existsSync(repo.path)) return repo;
    const removable = !repos.hasTasks(id);
    if (removable) repos.delete(id);
    throw new StaleRepoError(repo, removable);
  }

  return {
    list: (): RepoView[] =>
      repos.list().map((repo) => ({ ...repo, exists: existsSync(repo.path) })),

    get: existing,

    use,

    /** Registers one git repo. Omitted check commands are suggested from its build files. */
    async add(input: RepoInput): Promise<Repo> {
      const parsed = repoInputSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const path = await canonicalFolder(parsed.data.path);
      const kind = await gitDirKind(path);
      if (kind === "none") throw new InvalidRepoError(`${path} is not the root of a git repo`);
      if (kind === "worktree") {
        throw new InvalidRepoError(`${path} is a git worktree; register its main repo instead`);
      }
      if (repos.getByPath(path)) throw new InvalidRepoError(`${path} is already registered`);
      return register(path, parsed.data);
    },

    /**
     * Registers every git repo under a root folder (bounded depth, skipping
     * `node_modules`, hidden folders and linked worktrees). Repos already in the
     * registry are reported as skipped.
     */
    async scan(input: RepoScanInput): Promise<RepoScanResult> {
      const parsed = repoScanInputSchema.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error);
      const root = await canonicalFolder(parsed.data.root);
      const result: RepoScanResult = { added: [], skipped: [] };
      for (const path of await findGitRepos(root, parsed.data.maxDepth)) {
        if (repos.getByPath(path)) result.skipped.push(path);
        else result.added.push(await register(path));
      }
      return result;
    },

    update(id: string, patch: RepoUpdate): Repo {
      existing(id);
      const parsed = repoUpdateSchema.safeParse(patch);
      if (!parsed.success) throw invalid(parsed.error);
      const { name, checkCommands, defaultCli, defaultOrigin } = parsed.data;
      return repos.update(id, {
        ...(name === undefined ? {} : { name }),
        ...(checkCommands === undefined ? {} : { checkCommands }),
        ...(defaultCli === undefined ? {} : { defaultCli }),
        ...(defaultOrigin === undefined ? {} : { defaultOrigin }),
      });
    },

    /** Removes a repo from the registry; refused while tasks reference it. */
    delete(id: string): void {
      const repo = existing(id);
      if (repos.hasTasks(id)) throw new RepoInUseError(repo);
      repos.delete(id);
    },

    /** Check commands suggested from the repo's current build files. */
    async suggestChecks(id: string): Promise<string[]> {
      return suggestCheckCommands(use(id).path);
    },

    /** Re-reads the `origin` remote and re-resolves its connection (e.g. after adding one). */
    async refresh(id: string): Promise<Repo> {
      const repo = use(id);
      const remoteUrl = await readOriginRemote(repo.path);
      return repos.update(id, { remoteUrl, connectionId: connectionIdFor(remoteUrl) });
    },
  };
}
