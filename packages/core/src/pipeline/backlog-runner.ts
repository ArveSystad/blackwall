import {
  TASK_STOPPED_ERROR,
  backlogCapFor,
  type AgentCli,
  type BacklogItem,
  type GeneralSettings,
  type Repo,
  type RepoBacklogRunner,
  type ServerEvent,
  type Task,
  type TaskStatus,
} from "@blackwall/shared";
import type { QuotaTracker } from "../agents/quota.js";
import type { Repositories } from "../db/repositories.js";
import { nextBacklogItem } from "./backlog.js";

/** How often the runner looks for work besides the events that free capacity. */
export const BACKLOG_TICK_MS = 30_000;
/** How long a repo is left alone after promoting one of its items threw. */
export const PROMOTION_RETRY_MS = 5 * 60_000;

/** Task statuses that end a task's turn and may free capacity. */
const SETTLED: readonly TaskStatus[] = ["done", "failed", "needs-you", "interrupted"];

export interface BacklogRunnerSettings {
  general(): Pick<
    GeneralSettings,
    | "maxTasksPerRepo"
    | "backlogRunner"
    | "maxBacklogTasksPerRepo"
    | "stopBacklogOnNeedsYou"
    | "githubIssuesRefreshSeconds"
  >;
  repoBacklogRunner(repoId: string): RepoBacklogRunner;
  setRepoBacklogHalt(repoId: string, taskId: string | null): RepoBacklogRunner;
}

export interface BacklogRunnerOptions {
  repositories: {
    repos: Pick<Repositories["repos"], "list">;
    backlogItems: Pick<Repositories["backlogItems"], "list">;
    tasks: Pick<Repositories["tasks"], "list" | "get">;
  };
  /** Promotes an item into a queued task, exactly like "Run now". */
  createTask: (item: BacklogItem) => Promise<Task>;
  /**
   * Adds the repo's next eligible remote issue as a waiting backlog item at
   * the end of its queue, or returns undefined when there is none. A throw
   * is logged and, like an empty result, leaves the repo alone for the
   * issue refresh interval.
   */
  importRemoteIssue?: (repo: Repo) => Promise<BacklogItem | undefined>;
  /** Resumes a task a usage limit interrupted. */
  resumeTask: (taskId: string) => void;
  settings: BacklogRunnerSettings;
  quota: Pick<QuotaTracker, "isPaused" | "release" | "nextReset">;
  /** The CLIs an item's resolved role agents run on: its repo's default CLI and its overrides. */
  clisFor: (item: BacklogItem) => AgentCli[];
  clock?: () => Date;
  intervalMs?: number;
  /** A repo's runner halted on a failed backlog task. */
  onHalt?: (repoId: string, taskId: string) => void;
  log?: (message: string) => void;
}

export type BacklogRunner = ReturnType<typeof createBacklogRunner>;

/** What an enabled, unhalted repo offers on a pass; see `pick`. */
type Picked = { item: BacklogItem } | { idle: true; quotaHeld: boolean };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Works through each repo's backlog on its own, like a built-in ralph loop.
 * On every tick it first resumes tasks a usage limit interrupted whose quota
 * has reset, then promotes at most one item per idle repo: no queued task in
 * the repo, a free run slot, fewer active backlog tasks than the repo's
 * backlog limit, no backlog task waiting on the user (when that setting is on), and
 * the item's CLIs not quota-paused. A failed backlog task halts its repo's
 * runner until the user resumes it.
 *
 * A repo with "Include remote issues" on whose queue has nothing to start
 * imports its next remote issue as a backlog item and promotes it in the same
 * pass. It imports nothing while a waiting item is held only by a quota pause
 * (the reset wakes the runner), and leaves the repo alone for the issue
 * refresh interval after an import that found nothing, threw, or was not
 * promoted.
 */
export function createBacklogRunner({
  repositories: r,
  createTask,
  importRemoteIssue,
  resumeTask,
  settings,
  quota,
  clisFor,
  clock = () => new Date(),
  intervalMs = BACKLOG_TICK_MS,
  onHalt = () => undefined,
  log = console.error,
}: BacklogRunnerOptions) {
  let running: Promise<void> | undefined;
  let again = false;
  /** Not ticking on its own (never started, or stopped); `tick()` still works. */
  let stopped = true;
  /** `stop()` was called: a pass in flight promotes nothing more. */
  let stopping = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let poked: ReturnType<typeof setTimeout> | undefined;
  /** Repos whose last promotion threw, until when they are left alone. */
  const retryAfter = new Map<string, number>();
  /** Repos whose last remote issue import was not promoted, until when none is tried. */
  const remoteCheckedAt = new Map<string, number>();

  function resumeReleased(): void {
    for (const taskId of quota.release()) {
      const task = r.tasks.get(taskId);
      // The user may have stopped it since; a stop is theirs to resume.
      if (task?.status !== "interrupted" || task.error === TASK_STOPPED_ERROR) continue;
      try {
        resumeTask(taskId);
      } catch (error) {
        log(`Could not resume task ${taskId} after its usage limit: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * The item to promote in a repo now; idle when the repo could take work but
   * its queue has none to start (`quotaHeld` when a waiting item sits out only
   * for a quota pause); undefined when the repo is not idle.
   */
  function pick(repo: Repo, tasks: readonly Task[]): Picked | undefined {
    const repoId = repo.id;
    const general = settings.general();
    const state = settings.repoBacklogRunner(repoId);
    if (!state.enabled || state.haltedTaskId !== null) return undefined;
    if ((retryAfter.get(repoId) ?? 0) > clock().getTime()) return undefined;

    const inRepo = tasks.filter((t) => t.repoId === repoId);
    // Tasks the user started come first: wait while any is queued.
    if (inRepo.some((t) => t.status === "queued")) return undefined;
    if (inRepo.filter((t) => t.status === "running").length >= general.maxTasksPerRepo) {
      return undefined;
    }

    const items = r.backlogItems.list(repoId);
    const promoted = new Set(items.flatMap((i) => (i.taskId ? [i.taskId] : [])));
    const fromBacklog = inRepo.filter((t) => promoted.has(t.id));
    const active = fromBacklog.filter((t) => t.status === "running").length;
    if (active >= backlogCapFor(repo, general)) return undefined;
    if (general.stopBacklogOnNeedsYou && fromBacklog.some((t) => t.status === "needs-you")) {
      return undefined;
    }

    // Items whose agents run on a quota-paused CLI sit this tick out.
    const candidates = items.map((item) =>
      item.status === "waiting" && clisFor(item).some((cli) => quota.isPaused(cli))
        ? { ...item, status: "paused" as const }
        : item,
    );
    const status = new Map(tasks.map((t) => [t.id, t.status]));
    const next = nextBacklogItem(candidates, (id) => status.get(id) === "done");
    const item = next && items.find((i) => i.id === next.id);
    if (item) return { item };
    const quotaHeld = items.some(
      (item, index) => item.status === "waiting" && candidates[index]?.status === "paused",
    );
    return { idle: true, quotaHeld };
  }

  /** Whether to import a remote issue into an idle repo now. */
  function wantsRemote(repo: Repo, result: Picked | undefined): boolean {
    if (!result || !("idle" in result) || result.quotaHeld) return false;
    if (!importRemoteIssue || !settings.repoBacklogRunner(repo.id).includeRemoteIssues) {
      return false;
    }
    return (remoteCheckedAt.get(repo.id) ?? 0) <= clock().getTime();
  }

  /** Leaves a repo's remote issues alone for the issue refresh interval. */
  function coolDown(repoId: string): void {
    const seconds = settings.general().githubIssuesRefreshSeconds;
    remoteCheckedAt.set(repoId, clock().getTime() + seconds * 1000);
  }

  /** Promotes an item; a throw leaves the repo alone for a while. True when promoted. */
  async function promote(repoId: string, item: BacklogItem): Promise<boolean> {
    try {
      await createTask(item);
      retryAfter.delete(repoId);
      return true;
    } catch (error) {
      retryAfter.set(repoId, clock().getTime() + PROMOTION_RETRY_MS);
      log(`Backlog item ${item.id} could not be promoted: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Imports the repo's next remote issue and promotes it in the same pass. */
  async function runRemote(
    repo: Repo,
    importIssue: (repo: Repo) => Promise<BacklogItem | undefined>,
  ): Promise<void> {
    let imported: BacklogItem | undefined;
    try {
      imported = await importIssue(repo);
    } catch (error) {
      log(`Remote issues for repo ${repo.id} could not be imported: ${errorMessage(error)}`);
    }
    if (!imported) {
      coolDown(repo.id);
      return;
    }
    // The item waits in the queue for the next start.
    if (stopping) return;
    const next = pick(repo, r.tasks.list());
    if (next && "item" in next && (await promote(repo.id, next.item))) {
      remoteCheckedAt.delete(repo.id);
    } else {
      coolDown(repo.id);
    }
  }

  async function once(): Promise<void> {
    resumeReleased();
    if (!settings.general().backlogRunner) return;
    for (const repo of r.repos.list()) {
      if (stopping) return;
      const result = pick(repo, r.tasks.list());
      if (result && "item" in result) await promote(repo.id, result.item);
      else if (importRemoteIssue && wantsRemote(repo, result)) {
        await runRemote(repo, importRemoteIssue);
      }
    }
  }

  /** Wakes up when the earliest quota pause ends. */
  function scheduleReset(): void {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = undefined;
    if (stopped) return;
    const next = quota.nextReset();
    if (!next) return;
    // Timers overflow past ~24.8 days; the interval covers anything later.
    const delay = Math.min(Math.max(0, next.getTime() - clock().getTime()) + 1000, 2 ** 31 - 1);
    resetTimer = setTimeout(() => void tick(), delay);
    resetTimer.unref?.();
  }

  /** One pass; overlapping calls fold into one more pass after the current one. */
  function tick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await once();
        } while (again);
      } catch (error) {
        log(`Backlog runner tick failed: ${errorMessage(error)}`);
      } finally {
        running = undefined;
        scheduleReset();
      }
    })();
    return running;
  }

  /** Ticks soon, once, however many events arrive meanwhile. */
  function poke(): void {
    if (stopped || poked) return;
    poked = setTimeout(() => {
      poked = undefined;
      void tick();
    }, 0);
  }

  /** Halts the repo's runner when a task promoted from its backlog failed. */
  function haltOnFailure(task: Task): void {
    const linked = r.backlogItems.list(task.repoId).some((item) => item.taskId === task.id);
    if (!linked || settings.repoBacklogRunner(task.repoId).haltedTaskId !== null) return;
    settings.setRepoBacklogHalt(task.repoId, task.id);
    log(`Backlog runner halted for repo ${task.repoId}: task ${task.id} failed`);
    onHalt(task.repoId, task.id);
  }

  return {
    tick,
    poke,

    /**
     * Reacts to engine and backlog events: a task that settled or was deleted
     * frees capacity (a failed backlog task halts its repo, a stopped one does
     * not, and deleting the halting task lifts the halt), a changed backlog may hold new
     * work, a quota change may end a pause.
     */
    handleEvent(event: ServerEvent): void {
      if (event.type === "task.upserted") {
        const { task } = event.payload;
        if (!SETTLED.includes(task.status)) return;
        if (task.status === "failed") haltOnFailure(task);
        poke();
      } else if (event.type === "task.removed") {
        // A deleted task that halted its repo's runner no longer holds it.
        for (const repo of r.repos.list()) {
          if (settings.repoBacklogRunner(repo.id).haltedTaskId === event.payload.taskId) {
            settings.setRepoBacklogHalt(repo.id, null);
          }
        }
        poke();
      } else if (event.type === "backlog.changed" || event.type === "quota.changed") {
        poke();
      }
    },

    /** Starts ticking on the interval, and once right away. */
    start(): void {
      if (!stopped) return;
      stopped = false;
      stopping = false;
      interval = setInterval(() => void tick(), intervalMs);
      interval.unref?.();
      void tick();
    },

    /** Stops ticking; resolves once a pass in flight has finished. */
    async stop(): Promise<void> {
      stopped = true;
      stopping = true;
      if (interval) clearInterval(interval);
      if (resetTimer) clearTimeout(resetTimer);
      if (poked) clearTimeout(poked);
      interval = resetTimer = poked = undefined;
      await running;
    },
  };
}
