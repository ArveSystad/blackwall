import { existsSync } from "node:fs";
import { realpath, rename as renameFolder, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_BRANCH,
  remoteRepoSlug,
  renamedRemoteUrl,
  renamedRepoPath,
  repoRenameInputSchema,
  reorderReposInputSchema,
  repoInputSchema,
  repoScanInputSchema,
  repoUpdateSchema,
  type Repo,
  type RepoInput,
  type RepoRenameResult,
  type RepoRenameStep,
  type RepoScanInput,
  type RepoScanResult,
  type RepoSync,
  type RepoUpdate,
  type RepoView,
  type Task,
} from "@blackwall/shared";
import { MissingCredentialError, type ConnectionService } from "../connections/service.js";
import type { Repositories } from "../db/repositories.js";
import { suggestCheckCommands, suggestRunCommands, suggestSetupCommands } from "./checks.js";
import { describeGitError } from "../git/errors.js";
import { GitError } from "../git/service.js";
import {
  gitDirKind,
  listWorktreePaths,
  pushBranch,
  readBranchSync,
  readOriginRemote,
  repairWorktrees,
  setOriginRemote,
} from "./git.js";
import type { RepoRenameLocks } from "./rename-lock.js";
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

/** Git refused the user's push of the default branch; carries git's own message. */
export class RepoPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoPushError";
  }
}

/** The repo has queued, running or delivering tasks, or is already being renamed. Maps to 409. */
export class RepoBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoBusyError";
  }
}

/** A rename step failed with a message safe to show the user, e.g. GitHub refused it. */
export class RepoRenameStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRenameStepError";
  }
}

/**
 * The GitHub side of a repo rename, implemented by the server. Both calls may
 * throw `MissingCredentialError`; other failures should be `RepoRenameStepError`.
 */
export interface RepoRenameGitHub {
  /** The repo's current name on GitHub; follows GitHub's redirect for a renamed repo. */
  currentName(remoteUrl: string): Promise<string>;
  renameRepo(remoteUrl: string, name: string): Promise<void>;
}

/** What `rename` needs beyond the registry; without it renaming is unavailable. */
export interface RepoRenameOptions {
  tasks: Pick<Repositories["tasks"], "list" | "update">;
  transaction: <T>(fn: () => T) => T;
  /** Tasks the engine is running or has queued. */
  busyTaskIds: () => Iterable<string>;
  /** Whether a memory backfill pass is studying the repo's tasks. */
  backfillRunning: (repoId: string) => boolean;
  locks: Pick<
    RepoRenameLocks,
    "hold" | "assertFree" | "isRenaming" | "markPartial" | "clearPartial" | "pendingName"
  >;
  github: RepoRenameGitHub;
  /** Moves a folder; defaults to `fs.promises.rename`. */
  fsRename?: (from: string, to: string) => Promise<void>;
}

export interface RepoServiceOptions {
  repos: Repositories["repos"];
  connections: Pick<ConnectionService, "resolve">;
  rename?: RepoRenameOptions | undefined;
}

export type RepoService = ReturnType<typeof createRepoService>;

/** The repo's default branch; `main` for an unknown repo. */
export function defaultBranchOf(repos: Pick<Repositories["repos"], "get">, repoId: string): string {
  return repos.get(repoId)?.defaultBranch ?? DEFAULT_BRANCH;
}

/** A reference repo as agents see it: its name and the absolute path of its folder. */
export interface ReferenceRepo {
  name: string;
  path: string;
}

/**
 * The reference repos in `ids`, looked up again on every call so a deleted repo
 * or folder is dropped from the next step. Unknown repos, folders that no longer
 * exist and the repo itself are skipped.
 */
export function referenceReposFrom(
  repos: Pick<Repositories["repos"], "get">,
  repoId: string,
  ids: readonly string[],
): ReferenceRepo[] {
  const refs: ReferenceRepo[] = [];
  for (const refId of ids) {
    if (refId === repoId) continue;
    const ref = repos.get(refId);
    if (ref && existsSync(ref.path)) refs.push({ name: ref.name, path: ref.path });
  }
  return refs;
}

/**
 * The repo's current reference repos, looked up again on every call so a
 * changed list applies to the next call; resolved as {@link referenceReposFrom}.
 */
export function referenceReposOf(
  repos: Pick<Repositories["repos"], "get">,
  repoId: string,
): ReferenceRepo[] {
  return referenceReposFrom(repos, repoId, repos.get(repoId)?.referenceRepoIds ?? []);
}

/** Rejects user-picked reference repo ids that name the repo itself or an unknown repo. */
export function checkReferenceRepoIds(
  repos: Pick<Repositories["repos"], "get">,
  repoId: string,
  ids: readonly string[],
): void {
  for (const refId of ids) {
    if (refId === repoId) throw new InvalidRepoError("A repo can't be its own reference repo");
    if (!repos.get(refId)) throw new InvalidRepoError(`Reference repo ${refId} not found`);
  }
}

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
export function createRepoService({ repos, connections, rename }: RepoServiceOptions) {
  function existing(id: string): Repo {
    const repo = repos.get(id);
    if (!repo) throw new RepoNotFoundError(id);
    return repo;
  }

  /** Removes a repo from the registry and from every other repo's reference repos. */
  function remove(id: string): void {
    for (const other of repos.list()) {
      if (other.referenceRepoIds.includes(id)) {
        repos.update(other.id, {
          referenceRepoIds: other.referenceRepoIds.filter((refId) => refId !== id),
        });
      }
    }
    repos.delete(id);
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
    fields: {
      name?: string | undefined;
      checkCommands?: string[] | undefined;
      setupCommands?: string[] | undefined;
    } = {},
  ): Promise<Repo> {
    const remoteUrl = await readOriginRemote(path);
    return repos.create({
      path,
      name: fields.name ?? basename(path),
      remoteUrl,
      connectionId: connectionIdFor(remoteUrl),
      checkCommands: fields.checkCommands ?? (await suggestCheckCommands(path)),
      setupCommands: fields.setupCommands ?? (await suggestSetupCommands(path)),
      runCommands: await suggestRunCommands(path),
    });
  }

  /**
   * The repo, if its folder still exists. A repo whose folder is gone is removed
   * from the registry (when no task references it and no rename of it is
   * running or awaiting a retry) and `StaleRepoError` is thrown.
   */
  function use(id: string): Repo {
    const repo = existing(id);
    if (existsSync(repo.path)) return repo;
    const removable = !repos.hasTasks(id) && !rename?.locks.isRenaming(id);
    if (removable) remove(id);
    throw new StaleRepoError(repo, removable);
  }

  /** Throws `RepoBusyError` while a task in the repo runs, waits or delivers, or a backfill studies it. */
  function assertRenameIdle(options: RepoRenameOptions, repo: Repo): void {
    const engineIds = new Set(options.busyTaskIds());
    const busy = options.tasks
      .list()
      .filter(
        (task) =>
          task.repoId === repo.id &&
          (task.status === "running" ||
            task.status === "queued" ||
            task.delivering ||
            engineIds.has(task.id)),
      );
    if (busy.length > 0) {
      throw new RepoBusyError(
        `Wait for these tasks in ${repo.name} to finish: ${busy.map((task) => task.title).join(", ")}`,
      );
    }
    if (options.backfillRunning(repo.id)) {
      throw new RepoBusyError(
        `${repo.name}'s past tasks are being studied for notes; try again later`,
      );
    }
  }

  async function renameSteps(
    options: RepoRenameOptions,
    repo: Repo,
    name: string,
  ): Promise<{ result: RepoRenameResult; tasks: Task[] }> {
    const { github } = options;
    const fsRename = options.fsRename ?? renameFolder;
    const oldPath = repo.path;
    const newPath = renamedRepoPath(oldPath, name);
    const oldWorktrees = worktreesRootOf(oldPath);
    const newWorktrees = worktreesRootOf(newPath);

    // An earlier, partial run may already have moved the folder.
    const livePath = existsSync(oldPath) ? oldPath : existsSync(newPath) ? newPath : null;
    if (!livePath) throw new InvalidRepoError(`${repo.name} no longer exists at ${oldPath}`);
    const liveOrigin = (await readOriginRemote(livePath)) ?? repo.remoteUrl;
    const slug = remoteRepoSlug(liveOrigin);
    const newOrigin = liveOrigin && renamedRemoteUrl(liveOrigin, name);
    if (!liveOrigin || !slug || !newOrigin) {
      throw new InvalidRepoError(`${repo.name}'s origin is not a GitHub repo`);
    }
    if (!connectionIdFor(liveOrigin)) {
      throw new InvalidRepoError(`No GitHub connection for ${slug.host}`);
    }
    for (const [from, to] of [
      [oldPath, newPath],
      [oldWorktrees, newWorktrees],
    ] as const) {
      if (existsSync(from) && existsSync(to) && !(await sameFolder(from, to))) {
        throw new InvalidRepoError(`${to} already exists`);
      }
    }
    const taken = repos
      .list()
      .find(
        (other) =>
          other.id !== repo.id &&
          (samePath(other.path, newPath) || samePath(other.path, newWorktrees)),
      );
    if (taken) throw new InvalidRepoError(`${taken.path} is already registered as ${taken.name}`);

    const completed: RepoRenameStep[] = [];
    const skipped: RepoRenameStep[] = [];
    const done = (step: RepoRenameStep, ran: boolean) => (ran ? completed : skipped).push(step);
    const result = (failed: RepoRenameResult["failed"], current: Repo = repo) => ({
      result: { repo: current, completed, skipped, failed },
      tasks: [] as Task[],
    });

    let currentName: string;
    try {
      currentName = await github.currentName(liveOrigin);
    } catch (error) {
      if (error instanceof MissingCredentialError) throw error;
      return result({ step: "github", message: stepMessage("github", error) });
    }
    if (
      currentName === name &&
      liveOrigin === newOrigin &&
      basename(livePath) === name &&
      oldPath === newPath
    ) {
      throw new InvalidRepoError(`Already named ${name}`);
    }
    try {
      if (currentName !== name) await github.renameRepo(liveOrigin, name);
      done("github", currentName !== name);
    } catch (error) {
      if (error instanceof MissingCredentialError) throw error;
      return result({ step: "github", message: stepMessage("github", error) });
    }

    let worktrees: string[];
    try {
      if (liveOrigin !== newOrigin) await setOriginRemote(livePath, newOrigin);
      done("origin", liveOrigin !== newOrigin);
      worktrees = (await listWorktreePaths(livePath)).map((path) =>
        movedPath(resolve(path), oldWorktrees, newWorktrees),
      );
    } catch (error) {
      return result({ step: "origin", message: stepMessage("origin", error) });
    }

    try {
      const movedRepo = await moveFolder(fsRename, oldPath, newPath);
      const movedWorktrees = await moveFolder(fsRename, oldWorktrees, newWorktrees);
      done("folder", movedRepo || movedWorktrees);
    } catch (error) {
      return result({ step: "folder", message: stepMessage("folder", error) });
    }

    try {
      const existingWorktrees = worktrees.filter((path) => existsSync(path));
      if (existingWorktrees.length > 0) await repairWorktrees(newPath, existingWorktrees);
      const remoteUrl = newOrigin;
      const saved = options.transaction(() => {
        const tasks = options.tasks
          .list()
          .filter(
            (task) =>
              task.repoId === repo.id &&
              task.worktreePath !== null &&
              (task.worktreePath === oldPath || isUnder(task.worktreePath, oldWorktrees)),
          )
          .map((task) =>
            options.tasks.update(task.id, {
              // In-repo tasks work in the repo's own folder.
              worktreePath:
                task.worktreePath === oldPath
                  ? newPath
                  : movedPath(task.worktreePath!, oldWorktrees, newWorktrees),
            }),
          );
        const updated = repos.update(repo.id, {
          path: newPath,
          remoteUrl,
          connectionId: connectionIdFor(remoteUrl),
          ...(repo.name === basename(oldPath) ? { name } : {}),
        });
        return { tasks, repo: updated };
      });
      completed.push("records");
      return { ...result(null, saved.repo), tasks: saved.tasks };
    } catch (error) {
      return result({ step: "records", message: stepMessage("records", error) });
    }
  }

  function list(): RepoView[] {
    return repos.list().map((repo) => ({
      ...repo,
      exists: existsSync(repo.path),
      renamePending: rename?.locks.pendingName(repo.id) ?? null,
    }));
  }

  return {
    list,

    get: existing,

    use,

    /** Throws `InvalidRepoError` when `ids` name the repo itself or an unknown repo. */
    checkReferenceRepos(repoId: string, ids: readonly string[]): void {
      checkReferenceRepoIds(repos, repoId, ids);
    },

    /**
     * Registers one git repo. Omitted check commands are suggested from its build
     * files, omitted setup commands from its lockfiles.
     */
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
      const {
        name,
        checkCommands,
        setupCommands,
        runCommands,
        defaultCli,
        defaultOrigin,
        maxBacklogTasks,
        defaultBranch,
        favorite,
        watchCi,
        defaultInRepo,
        jiraProject,
        referenceRepoIds,
        agentTrust,
        trustProjectMcp,
        trustProjectHooks,
      } = parsed.data;
      checkReferenceRepoIds(repos, id, referenceRepoIds ?? []);
      return repos.update(id, {
        ...(name === undefined ? {} : { name }),
        ...(checkCommands === undefined ? {} : { checkCommands }),
        ...(setupCommands === undefined ? {} : { setupCommands }),
        ...(runCommands === undefined ? {} : { runCommands }),
        ...(defaultCli === undefined ? {} : { defaultCli }),
        ...(defaultOrigin === undefined ? {} : { defaultOrigin }),
        ...(maxBacklogTasks === undefined ? {} : { maxBacklogTasks }),
        ...(defaultBranch === undefined ? {} : { defaultBranch }),
        ...(favorite === undefined ? {} : { favorite }),
        ...(watchCi === undefined ? {} : { watchCi }),
        ...(defaultInRepo === undefined ? {} : { defaultInRepo }),
        ...(jiraProject === undefined ? {} : { jiraProject }),
        ...(referenceRepoIds === undefined ? {} : { referenceRepoIds }),
        ...(agentTrust === undefined ? {} : { agentTrust }),
        ...(trustProjectMcp === undefined ? {} : { trustProjectMcp }),
        ...(trustProjectHooks === undefined ? {} : { trustProjectHooks }),
      });
    },

    /** Sets the manual order; `ids` must list every registered repo exactly once. */
    reorder(ids: string[]): RepoView[] {
      const parsed = reorderReposInputSchema.safeParse({ ids });
      if (!parsed.success) throw invalid(parsed.error);
      const known = new Set(repos.list().map((repo) => repo.id));
      if (ids.length !== known.size || !ids.every((repoId) => known.has(repoId))) {
        throw new InvalidRepoError("List every repo exactly once");
      }
      repos.reorder(ids);
      return list();
    },

    /** Removes a repo from the registry; refused while tasks reference it or it is being renamed. */
    delete(id: string): void {
      rename?.locks.assertFree(id);
      const repo = existing(id);
      if (repos.hasTasks(id)) throw new RepoInUseError(repo);
      remove(id);
    },

    /** Check commands suggested from the repo's current build files. */
    async suggestChecks(id: string): Promise<string[]> {
      return suggestCheckCommands(use(id).path);
    },

    /** Setup commands suggested from the repo's current lockfiles. */
    async suggestSetup(id: string): Promise<string[]> {
      return suggestSetupCommands(use(id).path);
    },

    /** Run commands suggested from the repo's current build files. */
    async suggestRun(id: string): Promise<string[]> {
      return suggestRunCommands(use(id).path);
    },

    /** Re-reads the `origin` remote and re-resolves its connection (e.g. after adding one). */
    async refresh(id: string): Promise<Repo> {
      const repo = use(id);
      const remoteUrl = await readOriginRemote(repo.path);
      return repos.update(id, { remoteUrl, connectionId: connectionIdFor(remoteUrl) });
    },

    /** Reads `origin` for repos without a remote whose folder exists, e.g. after an import. */
    async fillMissingRemotes(): Promise<void> {
      for (const repo of repos.list()) {
        if (repo.remoteUrl !== null || !existsSync(repo.path)) continue;
        const remoteUrl = await readOriginRemote(repo.path);
        if (remoteUrl)
          repos.update(repo.id, { remoteUrl, connectionId: connectionIdFor(remoteUrl) });
      }
    },

    /** The local default branch vs `origin/<branch>` as of the last fetch; `null` without both refs. */
    async sync(id: string): Promise<RepoSync | null> {
      const repo = use(id);
      return readBranchSync(repo.path, repo.defaultBranch);
    },

    /**
     * Pushes the local default branch to origin. Only the user does this, from
     * the Backlog, after confirming; the pipeline never pushes it. Never forces.
     */
    async push(id: string): Promise<RepoSync | null> {
      const repo = use(id);
      const mainBranch = repo.defaultBranch;
      const sync = await readBranchSync(repo.path, mainBranch);
      if (!sync) {
        throw new InvalidRepoError(
          `${repo.name} has no local ${mainBranch} or origin/${mainBranch}`,
        );
      }
      if (sync.ahead === 0) throw new InvalidRepoError("Nothing to push");
      if (sync.behind > 0) {
        throw new InvalidRepoError(
          `origin/${mainBranch} has ${sync.behind} commit${sync.behind === 1 ? "" : "s"} that aren't local; pull first`,
        );
      }
      try {
        await pushBranch(repo.path, mainBranch);
      } catch (error) {
        if (error instanceof GitError) throw new RepoPushError(describeGitError(error));
        throw error;
      }
      return readBranchSync(repo.path, mainBranch);
    },

    /**
     * Renames the repo on GitHub, points `origin` at the new address, renames
     * the folder and its `<repo>.worktrees` sibling, then updates the records.
     * Holds the repo's rename lock throughout, so no task in it starts meanwhile.
     * A failed step stops the rename without rolling back; calling it again
     * with the same name skips the steps that are already done.
     */
    async rename(id: string, name: string): Promise<{ result: RepoRenameResult; tasks: Task[] }> {
      if (!rename) throw new InvalidRepoError("Renaming is not available");
      const parsed = repoRenameInputSchema.safeParse({ name });
      if (!parsed.success) throw invalid(parsed.error);
      const repo = existing(id);
      const release = rename.locks.hold(id, repo.name);
      try {
        assertRenameIdle(rename, repo);
        const outcome = await renameSteps(rename, repo, parsed.data.name);
        const { completed, skipped, failed } = outcome.result;
        if (!failed) rename.locks.clearPartial(id);
        else if (completed.includes("github") || skipped.includes("github")) {
          rename.locks.markPartial(id, parsed.data.name);
        }
        return outcome;
      } finally {
        release();
      }
    },
  };
}

/** Where a repo's task worktrees live: the `<repo>.worktrees` folder next to it. */
function worktreesRootOf(repoPath: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`);
}

/** Whether `path` is inside `root` (case-insensitively on Windows). */
function isUnder(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}

/** `path` with `from` swapped for `to` when it lies inside `from`. */
function movedPath(path: string, from: string, to: string): string {
  return isUnder(path, from) ? join(to, relative(from, path)) : path;
}

/** Whether two existing paths are the same folder, e.g. when only their case differs. */
async function sameFolder(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * Moves `from` to `to` unless that already happened. Handles case-only renames,
 * where both paths name the same folder. False when nothing was moved.
 */
async function moveFolder(
  fsRename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
): Promise<boolean> {
  if (existsSync(to) && basename(await realpath(to)) === basename(to)) return false;
  if (!existsSync(from)) return false;
  try {
    await fsRename(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new RepoRenameStepError(
        `${from} is in use (close editors, terminals and running chats open in it) and retry`,
      );
    }
    throw error;
  }
  return true;
}

/** A failed step's message for the user; unexpected errors are logged. */
function stepMessage(step: RepoRenameStep, error: unknown): string {
  if (error instanceof GitError) return describeGitError(error);
  if (error instanceof RepoRenameStepError) return error.message;
  console.error(`Repo rename: the ${step} step failed`, error);
  return `${step} failed unexpectedly`;
}
