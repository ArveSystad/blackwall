import {
  REPO_RENAME_STEPS,
  githubRepoUrl,
  remoteRepoSlug,
  renamedRemoteUrl,
  renamedRepoPath,
  type ConnectionView,
  type RepoRenameResult,
  type RepoRenameStep,
  type RepoView,
  type Task,
  type TaskStatus,
} from "@blackwall/shared";

/** What each rename step did: ran, was already done, stopped the rename, or never ran. */
export type RenameStepState = "done" | "already" | "failed" | "not-run";

/**
 * Why Rename… is disabled for the repo, or `null` when it can run. A rename
 * that stopped partway may already have moved the folder, so a missing folder
 * doesn't block finishing it.
 */
export function renameDisabledReason(
  repo: RepoView,
  connection: ConnectionView | undefined,
  tasks: readonly Task[],
  dirty: boolean,
  /** Its Run project run is active; Windows can't move a folder a process runs in. */
  projectRunning = false,
): string | null {
  if (!repo.exists && repo.renamePending === null) return "Folder is missing";
  const busy = tasks.some(
    (task) =>
      task.repoId === repo.id &&
      (task.status === "queued" || task.status === "running" || task.delivering),
  );
  if (busy) return "A task in this repo is queued, running or delivering";
  if (projectRunning) return "Stop the running project first";
  const slug = remoteRepoSlug(repo.remoteUrl);
  if (!slug) return "Origin is not a GitHub repo";
  if (!connection) return `No GitHub connection for ${slug.host}`;
  if (dirty) return "Save or discard your changes first";
  return null;
}

/** Where the repo ends up after renaming it to `name`; null parts when the origin isn't GitHub. */
export function renamePreview(
  repo: Pick<RepoView, "path" | "remoteUrl">,
  name: string,
): { githubUrl: string | null; origin: string | null; path: string } {
  const slug = remoteRepoSlug(repo.remoteUrl);
  return {
    githubUrl: slug ? githubRepoUrl(slug, name) : null,
    origin: repo.remoteUrl ? renamedRemoteUrl(repo.remoteUrl, name) : null,
    path: renamedRepoPath(repo.path, name),
  };
}

/** Each step's state in a rename result; every step is `not-run` before the first try. */
export function stepStates(
  result: RepoRenameResult | null,
): Record<RepoRenameStep, RenameStepState> {
  const states = Object.fromEntries(REPO_RENAME_STEPS.map((step) => [step, "not-run"])) as Record<
    RepoRenameStep,
    RenameStepState
  >;
  if (!result) return states;
  for (const step of result.completed) states[step] = "done";
  for (const step of result.skipped) states[step] = "already";
  if (result.failed) states[result.failed.step] = "failed";
  return states;
}

const SESSION_KEPT_ACROSS: ReadonlySet<TaskStatus> = new Set([
  "needs-you",
  "interrupted",
  "failed",
]);

/**
 * The repo's tasks whose agent session is lost when their worktree moves: a
 * worktree under `<repo>.worktrees` and a status the next agent step resumes from.
 */
export function sessionResetTasks(
  repo: Pick<RepoView, "id" | "path">,
  tasks: readonly Task[],
): Task[] {
  // Windows paths may use either separator and any case.
  const normal = (path: string) => path.replaceAll("\\", "/").toLowerCase();
  const root = `${normal(repo.path)}.worktrees/`;
  return tasks.filter(
    (task) =>
      task.repoId === repo.id &&
      SESSION_KEPT_ACROSS.has(task.status) &&
      task.worktreePath !== null &&
      normal(task.worktreePath).startsWith(root),
  );
}
