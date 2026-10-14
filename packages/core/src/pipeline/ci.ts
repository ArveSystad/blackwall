import {
  ciMissingTokenHint,
  ciScopeHint,
  ciSsoHint,
  type CiCheck,
  type CiState,
  type ServerEvent,
  type Task,
  type TaskCi,
} from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";
import type { GitService } from "../git/service.js";
import type { RemoteSlug } from "./delivery.js";

/** First poll after the push: CI needs a moment to register its checks. */
export const FIRST_POLL_MS = 30_000;
/** Each later wait is this many times the one before… */
export const BACKOFF_FACTOR = 1.5;
/** …up to this long. */
export const MAX_POLL_MS = 5 * 60_000;
/** A watch still pending this long after it started ends `timed-out`. */
export const WATCH_CAP_MS = 60 * 60_000;
/** No checks this long after the watch started: the commit has no CI (`none`). */
export const NO_CHECKS_GRACE_MS = 3 * 60_000;
/** Wait before polling again after GitHub's rate limit; the backoff does not move. */
export const RATE_LIMIT_RETRY_MS = 10_000;
/** Most failing checks a Fix CI round gets the logs of. */
export const MAX_CI_FAILURES = 10;

/** GitHub rate-limited a poll; the watcher retries after {@link RATE_LIMIT_RETRY_MS}. */
export class CiRateLimitedError extends Error {
  constructor(message = "GitHub rate limit reached") {
    super(message);
    this.name = "CiRateLimitedError";
  }
}

/** The pushed commit a watch reads checks of. */
export interface CiTarget extends RemoteSlug {
  sha: string;
}

/** A source of checks the token can't read, and why. */
export interface CiUnreadable {
  source: "check-runs" | "statuses";
  reason: "scope" | "sso";
}

export interface CiReadResult {
  checks: CiCheck[];
  unreadable: CiUnreadable[];
  /** Blackwall has no token for the host. */
  missingToken?: boolean;
}

/** The outward calls the watcher makes, implemented by the server with the GitHub client. */
export interface CiPorts {
  /**
   * The commit's check runs and statuses. Throws {@link CiRateLimitedError}
   * when rate-limited; any other error counts as transient too.
   */
  readChecks(target: CiTarget, signal: AbortSignal): Promise<CiReadResult>;
  /** The end of a failing check's log or output; undefined when there is none. */
  logTail(target: CiTarget, check: CiCheck, signal: AbortSignal): Promise<string | undefined>;
}

/** A failing check and the end of its log, for a Fix CI round. */
export interface CiFailure {
  check: CiCheck;
  log: string | undefined;
}

export interface CiWatcherOptions {
  repositories: Pick<Repositories, "tasks" | "repos">;
  git: Pick<GitService, "headSha" | "remoteUrl">;
  /** Host and `owner/repo` of a GitHub/GHE remote; undefined when it is not one. */
  parseRemote(remoteUrl: string): RemoteSlug | undefined;
  ports: CiPorts;
  publish?: (event: ServerEvent) => void;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => Date;
  log?: (message: string) => void;
}

export type CiWatcher = ReturnType<typeof createCiWatcher>;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/** The wait after `step`: {@link BACKOFF_FACTOR} longer, in whole ms, up to {@link MAX_POLL_MS}. */
const nextStep = (step: number) => Math.min(Math.round(step * BACKOFF_FACTOR), MAX_POLL_MS);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The hint for sources the token can't read: SSO before scopes. */
function unreadableHint(host: string, unreadable: readonly CiUnreadable[]): string | null {
  if (unreadable.some((u) => u.reason === "sso")) return ciSsoHint(host);
  return unreadable.length > 0 ? ciScopeHint(host) : null;
}

/**
 * Watches CI on the commit a task pushed to a GitHub/GHE remote and keeps
 * the result on the task (`tasks.ci`), publishing each change. Polls first
 * after {@link FIRST_POLL_MS}, then backs off by {@link BACKOFF_FACTOR} up to
 * {@link MAX_POLL_MS}, until every check has completed or {@link WATCH_CAP_MS}
 * passed. Rate limits and other failures only delay the next poll. Watches
 * live in memory; {@link recover} resumes pending ones on startup.
 */
export function createCiWatcher({
  repositories: r,
  git,
  parseRemote,
  ports,
  publish = () => undefined,
  sleep = defaultSleep,
  now = () => new Date(),
  log = console.error,
}: CiWatcherOptions) {
  const controllers = new Map<string, AbortController>();
  /** Aborted by {@link stop}: log fetches for Fix CI in flight. */
  let lifetime = new AbortController();

  function save(taskId: string, ci: TaskCi | null): void {
    const task = r.tasks.update(taskId, { ci });
    publish({ type: "task.upserted", payload: { task } });
  }

  /** The commit to watch, or undefined when the repo doesn't watch CI or the remote isn't GitHub. */
  async function targetOf(task: Task): Promise<CiTarget | undefined> {
    const repo = r.repos.get(task.repoId);
    if (!repo?.watchCi || !task.worktreePath) return undefined;
    const remote = await git.remoteUrl(task.worktreePath);
    const slug = remote ? parseRemote(remote) : undefined;
    if (!slug) return undefined;
    return { ...slug, sha: await git.headSha(task.worktreePath) };
  }

  /** Runs one watch with its own controller; a newer watch of the task aborts it. */
  async function run(taskId: string, body: (signal: AbortSignal) => Promise<void>): Promise<void> {
    cancel(taskId);
    const controller = new AbortController();
    controllers.set(taskId, controller);
    try {
      await body(controller.signal);
    } catch (error) {
      // A deleted task can't be updated; its watch just ends.
      if (!controller.signal.aborted)
        log(`CI watch of task ${taskId} stopped: ${errorMessage(error)}`);
    } finally {
      if (controllers.get(taskId) === controller) controllers.delete(taskId);
    }
  }

  /** Polls until the checks complete, the cap passes or the watch is aborted. */
  async function poll(taskId: string, start: TaskCi, signal: AbortSignal): Promise<void> {
    let ci = start;
    const target: CiTarget = { host: ci.host, owner: ci.owner, repo: ci.repo, sha: ci.sha };
    const startedAt = Date.parse(ci.startedAt);
    const update = (state: CiState, patch: Partial<TaskCi>, finished: boolean) => {
      const at = now().toISOString();
      ci = { ...ci, ...patch, state, updatedAt: at, finishedAt: finished ? at : null };
      save(taskId, ci);
    };
    let step = FIRST_POLL_MS;
    let wait = step;
    for (;;) {
      const left = startedAt + WATCH_CAP_MS - now().getTime();
      if (left <= 0) return update("timed-out", {}, true);
      await sleep(Math.min(wait, left), signal);
      if (signal.aborted) return;

      let result: CiReadResult;
      try {
        result = await ports.readChecks(target, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof CiRateLimitedError) {
          wait = RATE_LIMIT_RETRY_MS;
          continue;
        }
        log(`Reading CI for task ${taskId} failed: ${errorMessage(error)}`);
        step = nextStep(step);
        wait = step;
        continue;
      }
      if (signal.aborted) return;
      step = nextStep(step);
      wait = step;

      if (result.missingToken) {
        return update("unavailable", { checks: [], hint: ciMissingTokenHint(target.host) }, true);
      }
      const hint = unreadableHint(target.host, result.unreadable);
      const { checks } = result;
      if (checks.length === 0) {
        if (result.unreadable.some((u) => u.source === "check-runs")) {
          return update("unavailable", { checks, hint }, true);
        }
        if (now().getTime() - startedAt >= NO_CHECKS_GRACE_MS) {
          return update("none", { checks, hint }, true);
        }
        update("pending", { checks, hint }, false);
        continue;
      }
      const running = checks.some((c) => c.state === "pending");
      const failed = checks.some((c) => c.state === "failed");
      // A failure shows straight away; the watch goes on until every check has completed.
      update(failed ? "failed" : running ? "pending" : "passed", { checks, hint }, !running);
      if (!running) return;
    }
  }

  /**
   * Starts watching CI on the task's worktree `HEAD`, the commit just pushed,
   * replacing any earlier watch. A repo with `watchCi` off or a remote that is
   * not GitHub/GHE clears `ci` instead. Resolves when the watch ends.
   */
  function watch(taskId: string): Promise<void> {
    return run(taskId, async (signal) => {
      const task = r.tasks.get(taskId);
      if (!task) return;
      const target = await targetOf(task);
      if (signal.aborted) return;
      if (!target) {
        if (task.ci) save(taskId, null);
        return;
      }
      const at = now().toISOString();
      const ci: TaskCi = {
        state: "pending",
        ...target,
        checks: [],
        hint: null,
        startedAt: at,
        updatedAt: at,
        finishedAt: null,
      };
      save(taskId, ci);
      await poll(taskId, ci, signal);
    });
  }

  /** Stops the task's watch, if any; its stored state stays as it is. */
  function cancel(taskId: string): void {
    controllers.get(taskId)?.abort();
    controllers.delete(taskId);
  }

  return {
    watch,
    cancel,

    /**
     * The failing checks of the task's last watch (at most
     * {@link MAX_CI_FAILURES}) with the end of each one's log. A log that
     * can't be fetched is left out.
     */
    async failureContext(task: Task): Promise<CiFailure[]> {
      const ci = task.ci;
      if (!ci) return [];
      const target: CiTarget = { host: ci.host, owner: ci.owner, repo: ci.repo, sha: ci.sha };
      const failing = ci.checks.filter((c) => c.state === "failed").slice(0, MAX_CI_FAILURES);
      const { signal } = lifetime;
      return Promise.all(
        failing.map(async (check) => {
          try {
            return { check, log: await ports.logTail(target, check, signal) };
          } catch (error) {
            log(`Fetching the log of ${check.name} failed: ${errorMessage(error)}`);
            return { check, log: undefined };
          }
        }),
      );
    },

    /**
     * Startup (and after a data import): resumes every pending watch, and
     * ends those past {@link WATCH_CAP_MS} as `timed-out`. Resolves when the
     * resumed watches end.
     */
    recover(): Promise<void> {
      const resumed: Promise<void>[] = [];
      for (const task of r.tasks.list()) {
        const ci = task.ci;
        if (ci?.state !== "pending" || controllers.has(task.id)) continue;
        if (!r.repos.get(task.repoId)?.watchCi) {
          save(task.id, null);
        } else if (now().getTime() - Date.parse(ci.startedAt) >= WATCH_CAP_MS) {
          const at = now().toISOString();
          save(task.id, { ...ci, state: "timed-out", updatedAt: at, finishedAt: at });
        } else {
          resumed.push(run(task.id, (signal) => poll(task.id, ci, signal)));
        }
      }
      return Promise.all(resumed).then(() => undefined);
    },

    /** Aborts every watch and log fetch; {@link recover} picks pending watches up again. */
    stop(): void {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
