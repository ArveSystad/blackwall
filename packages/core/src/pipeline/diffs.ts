import type { BranchDiff, Task, TaskDiff } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import { archivedRefFor } from "../git/branches.js";
import { defaultBranchOf } from "../repos/service.js";
import {
  REVIEW_DIFF_EVENT,
  forkPoint,
  taskHead,
  type ReviewDiffRange,
  type ReviewGit,
} from "./stages.js";

/** Where git reads a task's branch: the folder to run in and the head ref. */
interface GitView {
  cwd: string;
  head: string;
  /** Read through the hidden ref of a removed worktree, where failures are soft. */
  archived: boolean;
}

/**
 * Where to read a task's branch: its repo through the hidden ref once
 * archiving removed the worktree (even with a leftover path), else the
 * worktree at {@link taskHead}. Null without either.
 */
function gitView(task: Task, repos: Pick<Repositories["repos"], "get">): GitView | null {
  if (task.worktreeRemovedAt) {
    const repo = repos.get(task.repoId);
    return repo ? { cwd: repo.path, head: archivedRefFor(task.id), archived: true } : null;
  }
  if (!task.worktreePath) return null;
  return { cwd: task.worktreePath, head: taskHead(task), archived: false };
}

export interface TaskDiffsOptions {
  repositories: Pick<Repositories, "repos" | "runs" | "steps" | "stepEvents">;
  git: ReviewGit;
}

/**
 * The task branch's changes per fix round, from the latest run: each range
 * Code review reviewed (recorded on its harness step), then the commits made
 * since the last review, unreviewed. Before any review that is the whole
 * branch since its fork point. A range reviewed again within a run shows
 * once: a review task's "Review again" covers the same range; a re-review
 * opens a new run, which covers only the commits pushed since. Empty without
 * a worktree. Once archiving removed the worktree it reads through the hidden
 * ref: a missing ref gives `[]`, and a range that no longer resolves is dropped.
 */
export function createTaskDiffs({ repositories: r, git }: TaskDiffsOptions) {
  async function rangeDiffs(task: Task, { cwd, head: headRef, archived }: GitView) {
    const run = r.runs.listByTask(task.id).at(-1);
    const steps = run ? r.steps.listByRun(run.id) : [];

    const reviews = steps.filter((s) => s.stage === "code-review" && s.agentId === null);
    // Events come in sequence order per step, so the last one per step wins.
    const lastRange = new Map(
      r.stepEvents
        .listOfTypes(
          reviews.map((s) => s.id),
          [REVIEW_DIFF_EVENT],
        )
        .map((e) => [e.stepId, e]),
    );
    const ranges: (ReviewDiffRange & { round: number; reviewed: boolean })[] = [];
    for (const step of reviews) {
      const range = lastRange.get(step.id)?.payload as ReviewDiffRange | undefined;
      if (!range || ranges.some((seen) => seen.from === range.from && seen.to === range.to)) {
        continue;
      }
      ranges.push({ ...range, round: step.round, reviewed: true });
    }

    const head = await git.headSha(cwd, headRef);
    const from =
      ranges.at(-1)?.to ??
      (await forkPoint(task, git, cwd, defaultBranchOf(r.repos, task.repoId), headRef));
    if (from && from !== head) {
      const round = Math.max(0, ...steps.map((s) => s.round));
      ranges.push({ from, to: head, round, reviewed: false });
    }

    const diffs = await Promise.all(
      ranges.map(async (range): Promise<TaskDiff | null> => {
        try {
          return { ...range, diff: await git.diff(cwd, range.from, range.to) };
        } catch (error) {
          if (archived) return null;
          throw error;
        }
      }),
    );
    return diffs.filter((d) => d !== null);
  }

  return async function taskDiffs(task: Task): Promise<TaskDiff[]> {
    const view = gitView(task, r.repos);
    if (!view) return [];
    return view.archived ? rangeDiffs(task, view).catch(() => []) : rangeDiffs(task, view);
  };
}

export type TaskDiffs = ReturnType<typeof createTaskDiffs>;

/**
 * The task branch's whole diff, from its fork point to HEAD, which line
 * numbers in the current files match. Null without a worktree, without a fork
 * point, or before the branch has commits of its own. Once archiving removed
 * the worktree it reads through the hidden ref; a missing ref gives null.
 */
export function createBranchDiff({
  git,
  repositories: r,
}: {
  git: ReviewGit;
  repositories: Pick<Repositories, "repos">;
}) {
  async function read(task: Task, { cwd, head }: GitView): Promise<BranchDiff | null> {
    const from = await forkPoint(task, git, cwd, defaultBranchOf(r.repos, task.repoId), head);
    if (!from) return null;
    const to = await git.headSha(cwd, head);
    if (from === to) return null;
    return { from, to, diff: await git.diff(cwd, from, to) };
  }

  return async function branchDiff(task: Task): Promise<BranchDiff | null> {
    const view = gitView(task, r.repos);
    if (!view) return null;
    return view.archived ? read(task, view).catch(() => null) : read(task, view);
  };
}

/** Serves a task's {@link BranchDiff}. */
export type TaskBranchDiff = ReturnType<typeof createBranchDiff>;
