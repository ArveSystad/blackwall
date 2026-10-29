import type { Task } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";

/** A pull request's state on GitHub: open or closed, and if closed, merged into `baseRef`. */
export interface PullRequestMergeState {
  state: "open" | "closed";
  merged: boolean;
  /** The branch the pull request targets. */
  baseRef: string;
}

/** How often held memories are checked against their pull request. */
export const MEMORY_RELEASE_INTERVAL_MS = 15 * 60_000;

export interface MemoryReleaserOptions {
  repositories: Pick<Repositories, "memories" | "tasks" | "repos">;
  /** The task's pull request as GitHub sees it; throws without a token or on network errors. */
  prMergeState: (task: Task, signal: AbortSignal) => Promise<PullRequestMergeState>;
  intervalMs?: number;
  log?: (message: string) => void;
  /** Called with a repo's id after a pass releases or discards any of its memories. */
  onChanged?: (repoId: string) => void;
}

export type MemoryReleaser = ReturnType<typeof createMemoryReleaser>;

/**
 * Releases the memories pull request tasks saved at Summarize once their pull
 * request merges into the repo's default branch, and discards them when it is
 * closed unmerged or merged elsewhere. Checks at start and every
 * {@link MEMORY_RELEASE_INTERVAL_MS}; an open pull request, or one that cannot
 * be checked, keeps its notes for the next pass. `onChanged` hears of each
 * repo whose memories a pass changed.
 */
export function createMemoryReleaser({
  repositories,
  prMergeState,
  intervalMs = MEMORY_RELEASE_INTERVAL_MS,
  log = console.error,
  onChanged = () => undefined,
}: MemoryReleaserOptions) {
  const { memories, tasks, repos } = repositories;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lifetime = new AbortController();
  let running: Promise<void> | undefined;

  const discard = (taskId: string | null) => {
    for (const repoId of memories.discardAwaiting(taskId)) onChanged(repoId);
  };

  async function pass(signal: AbortSignal): Promise<void> {
    // Their task was deleted, so no pull request can release them.
    discard(null);
    for (const taskId of memories.tasksAwaitingMerge()) {
      if (signal.aborted) return;
      const task = tasks.get(taskId);
      const repo = task && repos.get(task.repoId);
      if (!task || !repo || task.origin.kind !== "github-pr") {
        discard(taskId);
        continue;
      }
      let pr: PullRequestMergeState;
      try {
        pr = await prMergeState(task, signal);
      } catch (error) {
        if (!signal.aborted) {
          log(
            `Memory release of task ${taskId} skipped: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      if (signal.aborted) return;
      if (pr.merged && pr.baseRef === repo.defaultBranch) {
        memories.releaseForTask(taskId);
        onChanged(task.repoId);
      } else if (pr.state === "closed") discard(taskId);
    }
  }

  /** One pass over the held memories; a call during a pass waits for that pass. */
  function check(): Promise<void> {
    running ??= pass(lifetime.signal).finally(() => {
      running = undefined;
    });
    return running;
  }

  const tick = () => {
    check().catch((error: unknown) =>
      log(`Memory release failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  return {
    check,
    /** Checks now, then every `intervalMs`. */
    start(): void {
      if (timer) return;
      lifetime = new AbortController();
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    /** Stops the timer and aborts a pass in flight. */
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
      lifetime.abort();
    },
  };
}
