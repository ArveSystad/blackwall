import type { BranchDiff, Task, TaskDiff } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { defaultBranchOf } from "../repos/service.js";
import { REVIEW_DIFF_EVENT, forkPoint, type ReviewDiffRange, type ReviewGit } from "./stages.js";

export interface TaskDiffsOptions {
  repositories: Pick<Repositories, "repos" | "runs" | "steps" | "stepEvents">;
  git: ReviewGit;
}

/**
 * The task branch's changes per fix round, from the latest run: each range
 * Code review reviewed (recorded on its harness step), then the commits made
 * since the last review, unreviewed. Before any review that is the whole
 * branch since its fork point. A range reviewed again shows once: a review
 * task's re-reviews cover the same range. Empty without a worktree.
 */
export function createTaskDiffs({ repositories: r, git }: TaskDiffsOptions) {
  return async function taskDiffs(task: Task): Promise<TaskDiff[]> {
    const worktree = task.worktreePath;
    if (!worktree) return [];
    const run = r.runs.listByTask(task.id).at(-1);
    const steps = run ? r.steps.listByRun(run.id) : [];

    const ranges: (ReviewDiffRange & { round: number; reviewed: boolean })[] = [];
    for (const step of steps) {
      if (step.stage !== "code-review" || step.agentId !== null) continue;
      const event = r.stepEvents
        .list(step.id)
        .filter((e) => e.type === REVIEW_DIFF_EVENT)
        .at(-1);
      const range = event?.payload as ReviewDiffRange | undefined;
      if (!range || ranges.some((seen) => seen.from === range.from && seen.to === range.to)) {
        continue;
      }
      ranges.push({ ...range, round: step.round, reviewed: true });
    }

    const head = await git.headSha(worktree);
    const from =
      ranges.at(-1)?.to ??
      (await forkPoint(task, git, worktree, defaultBranchOf(r.repos, task.repoId)));
    if (from && from !== head) {
      const round = Math.max(0, ...steps.map((s) => s.round));
      ranges.push({ from, to: head, round, reviewed: false });
    }

    return Promise.all(
      ranges.map(async (range) => ({
        ...range,
        diff: await git.diff(worktree, range.from, range.to),
      })),
    );
  };
}

export type TaskDiffs = ReturnType<typeof createTaskDiffs>;

/**
 * The task branch's whole diff, from its fork point to HEAD, which line
 * numbers in the current files match. Null without a worktree, without a fork
 * point, or before the branch has commits of its own.
 */
export function createBranchDiff({
  git,
  repositories: r,
}: {
  git: ReviewGit;
  repositories: Pick<Repositories, "repos">;
}) {
  return async function branchDiff(task: Task): Promise<BranchDiff | null> {
    const worktree = task.worktreePath;
    if (!worktree) return null;
    const from = await forkPoint(task, git, worktree, defaultBranchOf(r.repos, task.repoId));
    if (!from) return null;
    const to = await git.headSha(worktree);
    if (from === to) return null;
    return { from, to, diff: await git.diff(worktree, from, to) };
  };
}

/** Serves a task's {@link BranchDiff}. */
export type TaskBranchDiff = ReturnType<typeof createBranchDiff>;
