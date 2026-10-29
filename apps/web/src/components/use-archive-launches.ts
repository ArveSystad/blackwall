import type { Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { archiveTask } from "../api";
import { CRUMBLE_FAILED_MS, CRUMBLE_MS, crumbleDelays, type Crumble } from "../crumble";
import { queryKeys } from "../query";
import { prefersReducedMotion } from "../reduced-motion";
import { errorMessage } from "../settings-forms";

/**
 * How long an archived done dot flies to the horizon; mirrors `.bw-launch` in
 * styles.css. The inbox row's crumble pairs with `.bw-crumble` in crumble.ts.
 */
export const LAUNCH_MS = 900;

/** Where a task's done dot sits on the grid, if it is shown. */
export type Locate = (taskId: string) => { x: number; y: number } | undefined;

/** Done dots and inbox rows being archived, and the last archive error; see `useArchiveLaunches`. */
export interface ArchiveLaunches {
  /** The spot each archived dot launched from, by task id, until it lands. */
  launches: ReadonlyMap<string, { x: number; y: number }>;
  /** Inbox rows crumbling out as they are archived, by task id, until they are dropped. */
  crumbles: ReadonlyMap<string, Crumble>;
  error: string | null;
  /** Clears the last archive error, as another grid action starts. */
  clearError: () => void;
  /** Archives a done task and launches its dot from `x`, `y`. */
  archive: (task: Task, x: number, y: number) => void;
  /** Sets where a task's done dot sits on the grid; `GridAgents` sets it while mounted. */
  setLocate: (locate: Locate | null) => void;
  /** Archives done tasks at once, launching every dot `setLocate` placed together. */
  archiveAll: (tasks: readonly Task[]) => void;
  /**
   * Crumbles the task's inbox and Backlog rows while `run` archives it (the
   * task page's and the Backlog's Archive buttons), starting after `delayMs`
   * so the Backlog's "Archive done" staggers; `run` resolves whether it did.
   * Resolves the same.
   */
  crumble: (task: Task, run: () => Promise<boolean>, delayMs?: number) => Promise<boolean>;
}

export const ArchiveLaunchesContext = createContext<ArchiveLaunches | null>(null);

/** The shell's archive launches, shared by the inbox and the grid; see `ArchiveLaunchesProvider`. */
export function useArchive(): ArchiveLaunches {
  const launch = useContext(ArchiveLaunchesContext);
  if (!launch) throw new Error("useArchive needs an ArchiveLaunchesProvider");
  return launch;
}

/**
 * Archiving done dots from the grid (`GridAgents`) or all at once from the
 * inbox. The request fires at once; a launch is dropped after `LAUNCH_MS` (a
 * timeout, since reduced motion turns the animation off) or as soon as its
 * request fails, which brings the dot back. Kept by the shell route, so a
 * flight outlives both the dot and the home view.
 *
 * Every archive, including the task page's (`crumble`), also crumbles the
 * task's inbox row: it goes after `CRUMBLE_MS` (at once under reduced motion),
 * but is only dropped once its request succeeded and the tasks refetched, so
 * it never pops back. A failed request brings the row back with a red flash
 * for `CRUMBLE_FAILED_MS`.
 */
export function useArchiveLaunches(): ArchiveLaunches {
  const queryClient = useQueryClient();
  const [launches, setLaunches] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  const [crumbles, setCrumbles] = useState<ReadonlyMap<string, Crumble>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const timers = useRef(new Map<string, number>());
  const locate = useRef<Locate | null>(null);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const setLocate = useCallback((next: Locate | null) => {
    locate.current = next;
  }, []);

  const land = useCallback((taskId: string) => {
    window.clearTimeout(timers.current.get(taskId));
    timers.current.delete(taskId);
    setLaunches((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const dropCrumble = useCallback((taskId: string) => {
    setCrumbles((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const startCrumble = useCallback((task: Task, delayMs: number) => {
    const key = `crumble:${task.id}`;
    window.clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    const reduced = prefersReducedMotion();
    setCrumbles((prev) =>
      new Map(prev).set(task.id, {
        task,
        delayMs,
        phase: reduced ? "gone" : "crumbling",
        archived: false,
        failures: prev.get(task.id)?.failures ?? 0,
      }),
    );
    if (reduced) return;
    timers.current.set(
      key,
      window.setTimeout(() => {
        timers.current.delete(key);
        setCrumbles((prev) => {
          const crumble = prev.get(task.id);
          if (!crumble) return prev;
          const next = new Map(prev);
          if (crumble.archived) next.delete(task.id);
          else next.set(task.id, { ...crumble, phase: "gone" });
          return next;
        });
      }, delayMs + CRUMBLE_MS),
    );
  }, []);

  const settleCrumble = useCallback(
    (taskId: string, ok: boolean) => {
      const key = `crumble:${taskId}`;
      if (ok) {
        setCrumbles((prev) => {
          const crumble = prev.get(taskId);
          if (!crumble) return prev;
          const next = new Map(prev);
          if (crumble.phase === "crumbling") next.set(taskId, { ...crumble, archived: true });
          else next.delete(taskId);
          return next;
        });
        return;
      }
      window.clearTimeout(timers.current.get(key));
      setCrumbles((prev) => {
        const crumble = prev.get(taskId);
        if (!crumble) return prev;
        return new Map(prev).set(taskId, {
          ...crumble,
          phase: "failed",
          failures: crumble.failures + 1,
        });
      });
      timers.current.set(
        key,
        window.setTimeout(() => {
          timers.current.delete(key);
          dropCrumble(taskId);
        }, CRUMBLE_FAILED_MS),
      );
    },
    [dropCrumble],
  );

  const archive = useCallback(
    (task: Task, x: number, y: number) => {
      setError(null);
      setLaunches((prev) => new Map(prev).set(task.id, { x, y }));
      window.clearTimeout(timers.current.get(task.id));
      timers.current.set(
        task.id,
        window.setTimeout(() => land(task.id), LAUNCH_MS),
      );
      startCrumble(task, 0);
      void archiveTask(task.id)
        .then(
          () => true,
          (cause: unknown) => {
            land(task.id);
            setError(`Could not archive ${task.title}: ${errorMessage(cause)}`);
            return false;
          },
        )
        .then(async (ok) => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
          settleCrumble(task.id, ok);
        });
    },
    [land, queryClient, settleCrumble, startCrumble],
  );

  const archiveAll = useCallback(
    (tasks: readonly Task[]) => {
      const pending = tasks.filter(
        (task) => !launches.has(task.id) && (crumbles.get(task.id)?.phase ?? "failed") === "failed",
      );
      if (pending.length === 0) return;
      setError(null);
      const spots = new Map<string, { x: number; y: number }>();
      for (const task of pending) {
        const spot = locate.current?.(task.id);
        if (spot) spots.set(task.id, { x: spot.x, y: spot.y });
      }
      if (spots.size > 0) {
        setLaunches((prev) => new Map([...prev, ...spots]));
        for (const taskId of spots.keys()) {
          window.clearTimeout(timers.current.get(taskId));
          timers.current.set(
            taskId,
            window.setTimeout(() => land(taskId), LAUNCH_MS),
          );
        }
      }
      const delays = crumbleDelays(pending);
      for (const task of pending) startCrumble(task, delays.get(task.id) ?? 0);
      void Promise.allSettled(pending.map((task) => archiveTask(task.id))).then(async (results) => {
        const failed: { task: Task; message: string }[] = [];
        results.forEach((result, index) => {
          const task = pending[index];
          if (result.status === "fulfilled" || !task) return;
          land(task.id);
          failed.push({ task, message: errorMessage(result.reason) });
        });
        const [first] = failed;
        if (first) {
          setError(
            failed.length === 1
              ? `Could not archive ${first.task.title}: ${first.message}`
              : `Could not archive ${failed.length} tasks: ${first.message}`,
          );
        }
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
        results.forEach((result, index) => {
          const task = pending[index];
          if (task) settleCrumble(task.id, result.status === "fulfilled");
        });
      });
    },
    [crumbles, launches, land, queryClient, settleCrumble, startCrumble],
  );

  const crumble = useCallback(
    async (task: Task, run: () => Promise<boolean>, delayMs = 0) => {
      startCrumble(task, delayMs);
      const ok = await run().catch(() => false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
      settleCrumble(task.id, ok);
      return ok;
    },
    [queryClient, settleCrumble, startCrumble],
  );

  return useMemo(
    () => ({ launches, crumbles, error, clearError, archive, setLocate, archiveAll, crumble }),
    [launches, crumbles, error, clearError, archive, setLocate, archiveAll, crumble],
  );
}
