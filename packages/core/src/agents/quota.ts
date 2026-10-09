import { AGENT_CLIS, type AgentCli, type QuotaState } from "@blackwall/shared";
import type { Repositories } from "../db/repositories.js";

/** Settings key holding the quota state, so a restart keeps pauses and waiting tasks. */
export const QUOTA_KEY = "quota";

/** First back-off when a CLI gives no reset time; doubles per consecutive hit. */
export const QUOTA_BACKOFF_MS = 15 * 60_000;
/** Longest back-off. */
export const QUOTA_BACKOFF_MAX_MS = 5 * 60 * 60_000;

/** What is stored per CLI. */
interface CliQuota {
  /** ISO time the quota resets; null when usable. */
  pausedUntil: string | null;
  /** Consecutive hits without a reset time, for the back-off. */
  strikes: number;
  /** Tasks a limit interrupted, to resume once the quota resets. */
  waiting: string[];
}

type Stored = Partial<Record<AgentCli, CliQuota>>;

export interface QuotaTrackerOptions {
  settings: Repositories["settings"];
  clock?: () => Date;
  /** Called with the new state whenever a pause starts or ends. */
  onChange?: (state: QuotaState[]) => void;
}

export type QuotaTracker = ReturnType<typeof createQuotaTracker>;

/**
 * Hard usage limits per agent CLI. A limit pauses the CLI until its reset
 * time, or, when the CLI gave none, for a back-off (15 min, doubling, at most
 * 5 h). Tasks a limit interrupted wait here until the pause ends.
 */
export function createQuotaTracker({
  settings,
  clock = () => new Date(),
  onChange = () => undefined,
}: QuotaTrackerOptions) {
  function load(): Stored {
    const raw = settings.get<Stored>(QUOTA_KEY);
    return raw && typeof raw === "object" ? raw : {};
  }

  function entry(stored: Stored, cli: AgentCli): CliQuota {
    const e = stored[cli];
    return {
      pausedUntil: typeof e?.pausedUntil === "string" ? e.pausedUntil : null,
      strikes: typeof e?.strikes === "number" ? e.strikes : 0,
      waiting: Array.isArray(e?.waiting) ? e.waiting.filter((id) => typeof id === "string") : [],
    };
  }

  /** The pause end, or null when the CLI is usable now. */
  function pausedUntil(cli: AgentCli, stored = load()): Date | null {
    const until = entry(stored, cli).pausedUntil;
    if (until === null) return null;
    const date = new Date(until);
    return date.getTime() > clock().getTime() ? date : null;
  }

  function state(stored = load()): QuotaState[] {
    return AGENT_CLIS.map((cli) => ({ cli, pausedUntil: pausedUntil(cli, stored) }));
  }

  function save(stored: Stored, changed: boolean): void {
    settings.set(QUOTA_KEY, stored);
    if (changed) onChange(state(stored));
  }

  return {
    pausedUntil: (cli: AgentCli): Date | null => pausedUntil(cli),
    isPaused: (cli: AgentCli): boolean => pausedUntil(cli) !== null,
    state: (): QuotaState[] => state(),

    /**
     * Records a limit hit: pauses the CLI until `resetsAt` (or a back-off) and
     * remembers the task it interrupted, if any. Returns the pause end.
     */
    report(cli: AgentCli, { resetsAt, taskId }: { resetsAt?: Date; taskId?: string } = {}): Date {
      const stored = load();
      const e = entry(stored, cli);
      const now = clock().getTime();
      let until: Date;
      if (resetsAt && resetsAt.getTime() > now) {
        until = resetsAt;
        e.strikes = 0;
      } else {
        // A still-running pause means this hit is part of the same window.
        const current = pausedUntil(cli, stored);
        if (current) {
          until = current;
        } else {
          until = new Date(now + Math.min(QUOTA_BACKOFF_MS * 2 ** e.strikes, QUOTA_BACKOFF_MAX_MS));
          e.strikes++;
        }
      }
      const changed = e.pausedUntil !== until.toISOString();
      e.pausedUntil = until.toISOString();
      if (taskId && !e.waiting.includes(taskId)) e.waiting.push(taskId);
      stored[cli] = e;
      save(stored, changed);
      return until;
    },

    /** A run on the CLI succeeded: the back-off starts over at its first step. */
    succeeded(cli: AgentCli): void {
      const stored = load();
      const e = entry(stored, cli);
      if (e.strikes === 0) return;
      e.strikes = 0;
      stored[cli] = e;
      save(stored, false);
    },

    /**
     * Ends pauses whose time has come and hands back the tasks that waited on
     * them, oldest first. A task that waited on a CLI still paused stays.
     */
    release(): string[] {
      const stored = load();
      const released: string[] = [];
      let changed = false;
      let touched = false;
      for (const cli of AGENT_CLIS) {
        const e = entry(stored, cli);
        if (pausedUntil(cli, stored) !== null) continue;
        if (e.pausedUntil !== null) {
          e.pausedUntil = null;
          changed = true;
        }
        if (e.pausedUntil === null && e.waiting.length > 0) {
          released.push(...e.waiting);
          e.waiting = [];
        }
        if (stored[cli]) {
          touched = true;
          stored[cli] = e;
        }
      }
      const blocked = new Set(
        AGENT_CLIS.filter((cli) => pausedUntil(cli, stored) !== null).flatMap(
          (cli) => entry(stored, cli).waiting,
        ),
      );
      if (touched && (changed || released.length > 0)) save(stored, changed);
      return [...new Set(released)].filter((id) => !blocked.has(id));
    },

    /** The earliest end of a running pause, to wake up then. */
    nextReset(): Date | null {
      const ends = state()
        .map((s) => s.pausedUntil)
        .filter((d): d is Date => d !== null)
        .map((d) => d.getTime());
      return ends.length > 0 ? new Date(Math.min(...ends)) : null;
    },
  };
}
