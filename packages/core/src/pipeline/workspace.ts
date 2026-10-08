import type { Task } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { branchForTask, worktreePathFor } from "../git/branches.js";
import type { GitService } from "../git/service.js";
import type { PreparedWorkspace } from "./engine.js";

export interface WorkspacePreparerOptions {
  git: Pick<GitService, "createWorktree">;
  repos: Pick<Repositories["repos"], "get">;
}

/**
 * Creates a task's worktree next to its repo. Free-text tasks get
 * `agent/<task-id>`; Jira and PR tasks use the branch set from their origin
 * (a new branch for Jira, the PR head branch for PRs). Idempotent, so a
 * resumed task finds its worktree where it left it.
 */
export function createWorkspacePreparer({ git, repos }: WorkspacePreparerOptions) {
  return async (task: Task): Promise<PreparedWorkspace> => {
    const repo = repos.get(task.repoId);
    if (!repo) throw new Error(`Repo ${task.repoId} not found`);
    const branch =
      task.branch ??
      (task.origin.kind === "free-text"
        ? branchForTask({ kind: "free-text", taskId: task.id })
        : undefined);
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

/** Delivery placeholder: nothing leaves the machine until the finish actions exist. */
export async function deliverNothing(): Promise<void> {}
