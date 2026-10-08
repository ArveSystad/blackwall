import type { Task, TaskDiff } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { REVIEW_DIFF_EVENT, forkPoint, type ReviewDiffRange, type ReviewGit } from "./stages.js";

export interface TaskDiffsOptions {
  repositories: Pick<Repositories, "runs" | "steps" | "stepEvents">;
  git: ReviewGit;
}

/**
 * The task branch's changes per fix round, from the latest run: each range
 * Code review reviewed (recorded on its harness step), then the commits made
 * since the last review, unreviewed. Before any review that is the whole
 * branch since its fork point. Empty without a worktree.
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
      if (range) ranges.push({ ...range, round: step.round, reviewed: true });
    }

    const head = await git.headSha(worktree);
    const from = ranges.at(-1)?.to ?? (await forkPoint(task, git, worktree));
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
