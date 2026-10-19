import type { Task } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { branchForTask, worktreePathFor } from "../git/branches.js";
import { describeGitError } from "../git/errors.js";
import { GitError, type GitService } from "../git/service.js";
import type { PreparedWorkspace } from "./engine.js";

export interface WorkspacePreparerOptions {
  git: Pick<GitService, "createWorktree">;
  repos: Pick<Repositories["repos"], "get">;
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
 */
export function createWorkspacePreparer({
  git,
  repos,
  branchFor,
  baseBranchFor,
}: WorkspacePreparerOptions) {
  return async (task: Task): Promise<PreparedWorkspace> => {
    const repo = repos.get(task.repoId);
    if (!repo) throw new Error(`Repo ${task.repoId} not found`);
    const branch =
      task.branch ??
      (task.origin.kind === "free-text"
        ? branchForTask({ kind: "free-text", taskId: task.id })
        : await branchFor?.(task));
    if (!branch) throw new Error("The task's branch is not known yet");
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

const errorMessage = (error: unknown) =>
  error instanceof GitError
    ? describeGitError(error)
    : error instanceof Error
      ? error.message
      : String(error);

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

export interface WorkspaceRemoverOptions {
  git: Pick<GitService, "removeWorktree">;
  repos: Pick<Repositories["repos"], "get">;
}

/**
 * Removes a deleted task's worktree and deletes its local branch. PR tasks
 * work on the PR's existing branch, so only their worktree goes. The repo's
 * default branch and other protected branches are refused by the git service.
 */
export function createWorkspaceRemover({ git, repos }: WorkspaceRemoverOptions) {
  return async (task: Task): Promise<void> => {
    const repo = repos.get(task.repoId);
    if (!repo || !task.worktreePath) return;
    const deleteBranch = task.origin.kind === "github-pr" || !task.branch ? undefined : task.branch;
    await git.removeWorktree({
      repoPath: repo.path,
      worktreePath: task.worktreePath,
      ...(deleteBranch ? { deleteBranch } : {}),
      mainBranch: repo.defaultBranch,
    });
  };
}
