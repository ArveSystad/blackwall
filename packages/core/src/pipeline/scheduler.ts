/** What the scheduler needs to know about a task. */
export interface SchedulableTask {
  id: string;
  repoId: string;
  /** Null until the branch is known; such a task only counts against its repo. */
  branch: string | null;
}

export interface SchedulerOptions {
  /** How many tasks may run at once in one repo; read on every pick so Settings apply live. */
  maxPerRepo: () => number;
  /** Whether the repo is locked (e.g. being renamed); its tasks keep their place until it isn't. */
  held?: ((repoId: string) => boolean) | undefined;
}

export type Scheduler = ReturnType<typeof createScheduler>;

/**
 * FIFO admission control for running tasks: at most `maxPerRepo` tasks run
 * per repo, and only one per branch. Different repos are independent. Only
 * running tasks hold a slot; a task waiting on the user is released and
 * enqueued again once answered. Nothing starts in a `held` repo.
 */
export function createScheduler({ maxPerRepo, held }: SchedulerOptions) {
  const queue: SchedulableTask[] = [];
  const active = new Map<string, SchedulableTask>();

  function fits(task: SchedulableTask): boolean {
    if (held?.(task.repoId)) return false;
    let inRepo = 0;
    for (const other of active.values()) {
      if (other.repoId !== task.repoId) continue;
      inRepo++;
      if (task.branch !== null && other.branch === task.branch) return false;
    }
    return inRepo < maxPerRepo();
  }

  return {
    /**
     * Queues a task unless it is already queued. A task that is still running
     * (e.g. answered the moment it reached a gate) waits until it is released.
     */
    enqueue(task: SchedulableTask): void {
      if (queue.some((t) => t.id === task.id)) return;
      queue.push({ ...task });
    },

    /** Drops a queued task (e.g. deleted). Running tasks are released with {@link release}. */
    dequeue(taskId: string): void {
      const i = queue.findIndex((t) => t.id === taskId);
      if (i >= 0) queue.splice(i, 1);
    },

    /**
     * Moves every queued task that fits into the running set, oldest first,
     * and returns them. A task that does not fit keeps its place in line
     * without blocking tasks for other repos or branches behind it.
     */
    take(): SchedulableTask[] {
      const started: SchedulableTask[] = [];
      for (let i = 0; i < queue.length;) {
        const task = queue[i]!;
        if (!active.has(task.id) && fits(task)) {
          queue.splice(i, 1);
          active.set(task.id, task);
          started.push(task);
        } else {
          i++;
        }
      }
      return started;
    },

    /** Updates a running task's branch once it is known (e.g. after the workspace is set up). */
    setBranch(taskId: string, branch: string | null): void {
      const task = active.get(taskId);
      if (task) task.branch = branch;
    },

    /** Frees a running task's slot. */
    release(taskId: string): void {
      active.delete(taskId);
    },

    isActive: (taskId: string): boolean => active.has(taskId),
    isQueued: (taskId: string): boolean => queue.some((t) => t.id === taskId),
    activeIds: (): string[] => [...active.keys()],
    queuedIds: (): string[] => queue.map((t) => t.id),
  };
}
