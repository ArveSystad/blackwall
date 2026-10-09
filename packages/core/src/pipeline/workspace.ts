import type { Task } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { branchForTask, worktreePathFor } from "../git/branches.js";
import type { GitService } from "../git/service.js";
import type { PreparedWorkspace } from "./engine.js";

export interface WorkspacePreparerOptions {
  git: Pick<GitService, "createWorktree">;
  repos: Pick<Repositories["repos"], "get">;
  /**
   * Derives the branch of a task created without one, e.g. a Jira task's
   * `feature/<key>-<slug>` from the issue's summary and type.
   */
  branchFor?: (task: Task) => Promise<string | undefined>;
}

/**
 * Creates a task's worktree next to its repo. Free-text tasks get
 * `agent/<task-id>`; Jira and PR tasks use the branch set from their origin
 * (a new branch for Jira, the PR head branch for PRs), asking `branchFor`
 * when the task has none yet. Idempotent, so a
 * resumed task finds its worktree where it left it.
 */
export function createWorkspacePreparer({ git, repos, branchFor }: WorkspacePreparerOptions) {
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
    await git.createWorktree({
      repoPath: repo.path,
      worktreePath,
      branch,
      checkout:
        task.origin.kind === "github-pr" ? { kind: "existing", fetch: true } : { kind: "new" },
    });
    return { branch, worktreePath };
  };
}

export interface WorkspaceRemoverOptions {
  git: Pick<GitService, "removeWorktree">;
  repos: Pick<Repositories["repos"], "get">;
}

/**
 * Removes a deleted task's worktree and deletes its local branch. PR tasks
 * work on the PR's existing branch, so only their worktree goes. Protected
 * branches are refused by the git service.
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
    });
  };
}
