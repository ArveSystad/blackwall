import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { Task } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { archivedRefFor, branchForTask, worktreePathFor } from "../git/branches.js";
import { errorMessage } from "../git/errors.js";
import type { GitService } from "../git/service.js";
import type { PreparedWorkspace } from "./engine.js";

/**
 * Which task holds each repo's own folder, for in-repo tasks. Prepares of one
 * repo run one at a time under {@link InRepoClaims.withRepoLock}, so two tasks
 * starting at once can't both switch the folder. Kept in memory: after a
 * restart the tasks' saved `worktreePath` alone shows which one holds it.
 */
export interface InRepoClaims {
  /** Runs `fn` after every earlier call for the same repo has settled. */
  withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T>;
  /** The task that claimed the repo's folder, if any. */
  holder(repoId: string): string | undefined;
  claim(repoId: string, taskId: string): void;
  /** Clears the claim only when `taskId` holds it. */
  release(repoId: string, taskId: string): void;
}

export function createInRepoClaims(): InRepoClaims {
  const locks = new Map<string, Promise<void>>();
  const claims = new Map<string, string>();
  return {
    async withRepoLock(repoId, fn) {
      const previous = locks.get(repoId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => (release = resolve));
      const tail = previous.then(() => current);
      locks.set(repoId, tail);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (locks.get(repoId) === tail) locks.delete(repoId);
      }
    },
    holder: (repoId) => claims.get(repoId),
    claim(repoId, taskId) {
      claims.set(repoId, taskId);
    },
    release(repoId, taskId) {
      if (claims.get(repoId) === taskId) claims.delete(repoId);
    },
  };
}

export interface WorkspacePreparerOptions {
  git: Pick<GitService, "createWorktree" | "switchBranch">;
  repos: Pick<Repositories["repos"], "get">;
  /** Finds the in-repo task that already holds a repo's folder. */
  tasks: Pick<Repositories["tasks"], "list">;
  claims: InRepoClaims;
  /**
   * Derives the branch of a task created without one, e.g. a Jira task's
   * `feature/<key>-<slug>` from the issue's summary and type, or a GitHub
   * issue task's `feature/<number>-<slug>` from its title and labels.
   */
  branchFor?: (task: Task) => Promise<string | undefined>;
  /**
   * A PR task's base branch, fetched with its head so the task's diffs fork
   * from it rather than from main: in a stack, the PR below.
   */
  baseBranchFor?: (task: Task) => Promise<string | undefined>;
}

/**
 * Creates a task's worktree next to its repo. Free-text tasks get
 * `agent/<task-id>`; Jira, GitHub issue and PR tasks use the branch set from
 * their origin (a new branch for issues, forked like free-text branches from
 * the repo's default branch; the PR head branch for PRs), asking `branchFor`
 * when the task has none yet. PR tasks also record and fetch the PR's base
 * branch from `baseBranchFor`. Idempotent, so a
 * resumed task finds its worktree where it left it.
 *
 * An in-repo task gets no worktree: its branch is checked out in the repo's
 * own folder, which becomes its `worktreePath`. Only one in-repo task per repo
 * may hold the folder; another one, or a folder with uncommitted changes on
 * another branch, fails the prepare rather than waiting.
 */
export function createWorkspacePreparer({
  git,
  repos,
  tasks,
  claims,
  branchFor,
  baseBranchFor,
}: WorkspacePreparerOptions) {
  /** Another active in-repo task holding the task's repo folder, if any. */
  function holderOf(task: Task): Task | undefined {
    const active = (other: Task | undefined): other is Task =>
      other !== undefined &&
      other.id !== task.id &&
      other.inRepo &&
      other.repoId === task.repoId &&
      other.status !== "done";
    const all = tasks.list();
    const claimed = claims.holder(task.repoId);
    if (claimed !== undefined && claimed !== task.id) {
      const other = all.find((t) => t.id === claimed);
      if (active(other)) return other;
      // Its task is gone or done, so it no longer holds the folder.
      claims.release(task.repoId, claimed);
    }
    return all.find((other) => active(other) && other.worktreePath !== null);
  }

  return async (task: Task): Promise<PreparedWorkspace> => {
    const repo = repos.get(task.repoId);
    if (!repo) throw new Error(`Repo ${task.repoId} not found`);
    const branch =
      task.branch ??
      (task.origin.kind === "free-text"
        ? branchForTask({ kind: "free-text", taskId: task.id })
        : await branchFor?.(task));
    if (!branch) throw new Error("The task's branch is not known yet");
    if (task.inRepo) {
      return claims.withRepoLock(repo.id, async () => {
        const holder = holderOf(task);
        if (holder) {
          throw new Error(
            `The repo folder is in use by task ${holder.title} (${holder.id}); finish or delete it first`,
          );
        }
        claims.claim(repo.id, task.id);
        try {
          await git.switchBranch({ repoPath: repo.path, branch, base: repo.defaultBranch });
        } catch (error) {
          claims.release(repo.id, task.id);
          throw error;
        }
        return { branch, worktreePath: repo.path, baseBranch: null };
      });
    }
    const worktreePath = task.worktreePath ?? worktreePathFor(repo.path, task.id);
    const isPr = task.origin.kind === "github-pr";
    const baseBranch = isPr ? (task.baseBranch ?? (await baseBranchFor?.(task))) : undefined;
    await git.createWorktree({
      repoPath: repo.path,
      worktreePath,
      branch,
      checkout: isPr
        ? { kind: "existing", fetch: true, ...(baseBranch ? { base: baseBranch } : {}) }
        : { kind: "new", base: repo.defaultBranch },
    });
    return { branch, worktreePath, baseBranch: baseBranch ?? null };
  };
}

export interface WorkspaceSyncerOptions {
  git: Pick<GitService, "remoteUrl" | "fetchDefault" | "fastForwardTo">;
  repos: Pick<Repositories["repos"], "get">;
}

/** What {@link createWorkspaceSyncer} did to a task's branch. */
export interface WorkspaceSync {
  /** Why fetching the remote default branch failed, or `null` when it worked or was skipped. */
  fetchError: string | null;
  /** Where the branch was fast-forwarded to, or `null` when it was left alone. */
  fastForward: { sha: string; onto: string } | null;
}

/**
 * Brings a task branch up to date before new work starts: fetches the repo's
 * default branch from `origin` when the repo has one (best effort; a failure
 * is reported, not thrown), then fast-forwards a clean branch with no commits
 * of its own to `origin/<default>`, or to the local default branch when that
 * is not an ancestor of it. PR tasks work on the PR's branch and are never
 * moved; tasks without a worktree or repo return `null`. Never pushes or moves
 * the default branch.
 */
export function createWorkspaceSyncer({ git, repos }: WorkspaceSyncerOptions) {
  return async (task: Task): Promise<WorkspaceSync | null> => {
    if (task.origin.kind === "github-pr" || !task.worktreePath || !task.branch) return null;
    const repo = repos.get(task.repoId);
    if (!repo) return null;
    let fetchError: string | null = null;
    if ((await git.remoteUrl(task.worktreePath)) !== null) {
      try {
        await git.fetchDefault(task.worktreePath, repo.defaultBranch);
      } catch (error) {
        fetchError = errorMessage(error);
      }
    }
    return {
      fetchError,
      fastForward: await git.fastForwardTo(task.worktreePath, task.branch, repo.defaultBranch),
    };
  };
}

export interface PrHeadSyncOptions {
  git: Pick<GitService, "fetchBranch" | "moveBranchTo">;
  repos: Pick<Repositories["repos"], "get">;
}

/** Fetches and moves a PR task's branch to the PR's head on the remote. */
export interface PrHeadSync {
  /** Fetches the PR head branch and returns the sha it points at; never touches the worktree. */
  fetch(task: Task): Promise<string>;
  /**
   * Moves the task's branch to `sha` when its worktree is clean and HEAD is
   * still `expectedHead`; `false` when it was left alone.
   */
  moveTo(task: Task, sha: string, expectedHead: string): Promise<boolean>;
}

/**
 * Keeps a PR task's branch in step with the PR's head branch on `origin`,
 * for re-reviewing the commits pushed since a review. The repo's default
 * branch is passed along so a protected branch is refused.
 */
export function createPrHeadSync({ git, repos }: PrHeadSyncOptions): PrHeadSync {
  const workspace = (task: Task) => {
    if (!task.worktreePath || !task.branch) throw new Error("The task has no worktree");
    return { worktreePath: task.worktreePath, branch: task.branch };
  };
  return {
    async fetch(task) {
      if (!task.branch) throw new Error("The task has no branch");
      // A removed worktree (or a leftover of one) is no place to run git in.
      const cwd = task.worktreeRemovedAt
        ? repos.get(task.repoId)?.path
        : (task.worktreePath ?? repos.get(task.repoId)?.path);
      if (!cwd) throw new Error("The task has no worktree");
      return git.fetchBranch(cwd, task.branch);
    },
    async moveTo(task, sha, expectedHead) {
      const { worktreePath, branch } = workspace(task);
      return git.moveBranchTo(
        worktreePath,
        branch,
        sha,
        expectedHead,
        repos.get(task.repoId)?.defaultBranch,
      );
    },
  };
}

export interface WorkspaceRemoverOptions {
  git: Pick<GitService, "removeWorktree" | "leaveBranch">;
  repos: Pick<Repositories["repos"], "get">;
  claims: InRepoClaims;
}

/**
 * Removes a deleted task's worktree and deletes its local branch. PR tasks
 * work on the PR's existing branch, so only their worktree goes; so does a
 * delivered task's (`keepBranch`), whose branch may hold unpushed commits. The
 * repo's default branch and other protected branches are refused by the git
 * service. An in-repo task's folder is the repo itself and is never removed:
 * see {@link GitService.leaveBranch}. Its claim on the folder is released.
 */
export function createWorkspaceRemover({ git, repos, claims }: WorkspaceRemoverOptions) {
  return async (task: Task, options?: { keepBranch?: boolean }): Promise<void> => {
    const repo = repos.get(task.repoId);
    if (!repo || !task.worktreePath) {
      claims.release(task.repoId, task.id);
      return;
    }
    const deleteBranch =
      options?.keepBranch || task.origin.kind === "github-pr" || !task.branch
        ? undefined
        : task.branch;
    if (task.inRepo) {
      try {
        if (task.branch) {
          await git.leaveBranch({
            repoPath: repo.path,
            branch: task.branch,
            to: repo.defaultBranch,
            ...(deleteBranch ? { deleteBranch } : {}),
            mainBranch: repo.defaultBranch,
          });
        }
      } finally {
        claims.release(repo.id, task.id);
      }
      return;
    }
    await git.removeWorktree({
      repoPath: repo.path,
      worktreePath: task.worktreePath,
      ...(deleteBranch ? { deleteBranch } : {}),
      mainBranch: repo.defaultBranch,
    });
  };
}

/**
 * Why archiving could not remove a task's worktree. `partial` means some of
 * it is gone (or the folder is, but its branch is not): the head is kept at
 * the hidden ref and the leftover must never be used as a live workspace.
 */
export class WorkspaceArchiveError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
  ) {
    super(message);
    this.name = "WorkspaceArchiveError";
  }
}

export interface WorkspaceArchiverOptions {
  git: Pick<
    GitService,
    | "headSha"
    | "setRef"
    | "deleteRef"
    | "refExists"
    | "createBranchAt"
    | "createWorktree"
    | "removeWorktree"
    | "worktreeIntact"
  >;
  repos: Pick<Repositories["repos"], "get">;
  claims: InRepoClaims;
}

/** Removes an archived task's worktree and brings it back when the task is reopened. */
export interface WorkspaceArchiver {
  /**
   * Keeps the worktree's head at {@link archivedRefFor}, then removes the
   * worktree (discarding uncommitted changes) and its local branch; PR tasks
   * keep theirs. `null` when there was nothing to remove (in-repo tasks, no
   * worktree or repo). Throws {@link WorkspaceArchiveError} on failure.
   */
  archive(task: Task): Promise<{ sha: string } | null>;
  /**
   * Rebuilds a removed worktree from the hidden ref (PR tasks: from their
   * branch), clearing a leftover of a partial removal first, then deletes
   * the ref.
   */
  restore(task: Task): Promise<{ worktreePath: string; branch: string | null }>;
  /**
   * Cleans up after a removed task is deleted: a leftover folder, its branch
   * (unless `keepBranch` or a PR task) and the hidden ref. With `keepBranch`,
   * a branch archiving deleted is recreated from the ref.
   */
  forget(task: Task, options?: { keepBranch?: boolean }): Promise<void>;
}

/**
 * Removes archived tasks' worktrees to save disk, keeping each head at a
 * hidden ref. The git work runs one operation at a time per repo, since
 * worktree commands are not retried on a lock and "Archive all" archives many
 * tasks of one repo at once; different repos run in parallel.
 */
export function createWorkspaceArchiver({
  git,
  repos,
  claims,
}: WorkspaceArchiverOptions): WorkspaceArchiver {
  const tails = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier call for the same repo has settled, whatever its outcome. */
  function serial<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(repoId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(repoId, tail);
    void tail.then(() => {
      if (tails.get(repoId) === tail) tails.delete(repoId);
    });
    return run;
  }

  /** Removes a leftover folder of a partial removal and prunes its registration. */
  async function clearLeftover(repoPath: string, worktreePath: string): Promise<void> {
    await git.removeWorktree({ repoPath, worktreePath });
    await rm(worktreePath, { recursive: true, force: true });
  }

  function branchToDelete(task: Task): string | undefined {
    return task.origin.kind === "github-pr" || !task.branch ? undefined : task.branch;
  }

  return {
    async archive(task) {
      if (task.inRepo) {
        claims.release(task.repoId, task.id);
        return null;
      }
      const repo = repos.get(task.repoId);
      const worktreePath = task.worktreePath;
      if (!repo || !worktreePath) return null;
      return serial(repo.id, async () => {
        const ref = archivedRefFor(task.id);
        const sha = await git.headSha(worktreePath);
        await git.setRef(repo.path, ref, sha);
        const deleteBranch = branchToDelete(task);
        try {
          await git.removeWorktree({
            repoPath: repo.path,
            worktreePath,
            ...(deleteBranch ? { deleteBranch } : {}),
            mainBranch: repo.defaultBranch,
          });
        } catch (error) {
          const partial =
            !existsSync(worktreePath) ||
            !(await git.worktreeIntact(repo.path, worktreePath).catch(() => false));
          if (!partial) await git.deleteRef(repo.path, ref).catch(() => undefined);
          throw new WorkspaceArchiveError(errorMessage(error), partial);
        }
        return { sha };
      });
    },

    async restore(task) {
      const repo = repos.get(task.repoId);
      if (!repo) throw new Error(`Repo ${task.repoId} not found`);
      return serial(repo.id, async () => {
        if (task.worktreePath) {
          try {
            await clearLeftover(repo.path, task.worktreePath);
          } catch (error) {
            throw new Error(
              `Could not clear the task's leftover worktree: ${errorMessage(error)}`,
              { cause: error },
            );
          }
        }
        const ref = archivedRefFor(task.id);
        if (!(await git.refExists(repo.path, ref))) {
          throw new Error("The task's archived commit was not found");
        }
        const branch = task.branch ?? branchForTask({ kind: "free-text", taskId: task.id });
        const worktreePath = worktreePathFor(repo.path, task.id);
        await git.createWorktree({
          repoPath: repo.path,
          worktreePath,
          branch,
          checkout:
            task.origin.kind === "github-pr" ? { kind: "existing" } : { kind: "new", base: ref },
        });
        await git.deleteRef(repo.path, ref);
        return { worktreePath, branch };
      });
    },

    async forget(task, options) {
      const repo = repos.get(task.repoId);
      if (!repo) return;
      await serial(repo.id, async () => {
        const ref = archivedRefFor(task.id);
        const deleteBranch = options?.keepBranch ? undefined : branchToDelete(task);
        if (task.worktreePath) {
          await clearLeftover(repo.path, task.worktreePath).catch(() => undefined);
        }
        if (deleteBranch) {
          // No worktree path: only the branch (if any survived) goes.
          await git.removeWorktree({
            repoPath: repo.path,
            worktreePath: worktreePathFor(repo.path, task.id),
            deleteBranch,
            mainBranch: repo.defaultBranch,
          });
        } else if (
          options?.keepBranch &&
          task.origin.kind !== "github-pr" &&
          task.branch &&
          (await git.refExists(repo.path, ref))
        ) {
          await git.createBranchAt(repo.path, task.branch, ref, repo.defaultBranch);
        }
        await git.deleteRef(repo.path, ref);
      });
    },
  };
}
