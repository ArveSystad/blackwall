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
import { queryKeys } from "../query";
import { errorMessage } from "../settings-forms";

/** How long an archived done dot flies to the horizon; mirrors `.bw-launch` in styles.css. */
export const LAUNCH_MS = 900;

/** Where a task's done dot sits on the grid, if it is shown. */
export type Locate = (taskId: string) => { x: number; y: number } | undefined;

/** Done dots being archived, and the last archive error; see `useArchiveLaunches`. */
export interface ArchiveLaunches {
  /** The spot each archived dot launched from, by task id, until it lands. */
  launches: ReadonlyMap<string, { x: number; y: number }>;
  error: string | null;
  /** Clears the last archive error, as another grid action starts. */
  clearError: () => void;
  /** Archives a done task and launches its dot from `x`, `y`. */
  archive: (task: Task, x: number, y: number) => void;
  /** Sets where a task's done dot sits on the grid; `GridAgents` sets it while mounted. */
  setLocate: (locate: Locate | null) => void;
  /** Archives done tasks at once, launching every dot `setLocate` placed together. */
  archiveAll: (tasks: readonly Task[]) => void;
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
 */
export function useArchiveLaunches(): ArchiveLaunches {
  const queryClient = useQueryClient();
  const [launches, setLaunches] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
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

  const archive = useCallback(
    (task: Task, x: number, y: number) => {
      setError(null);
      setLaunches((prev) => new Map(prev).set(task.id, { x, y }));
      window.clearTimeout(timers.current.get(task.id));
      timers.current.set(
        task.id,
        window.setTimeout(() => land(task.id), LAUNCH_MS),
      );
      archiveTask(task.id)
        .catch((cause: unknown) => {
          land(task.id);
          setError(`Could not archive ${task.title}: ${errorMessage(cause)}`);
        })
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
        });
    },
    [land, queryClient],
  );

  const archiveAll = useCallback(
    (tasks: readonly Task[]) => {
      const pending = tasks.filter((task) => !launches.has(task.id));
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
      void Promise.allSettled(pending.map((task) => archiveTask(task.id))).then((results) => {
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
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
      });
    },
    [launches, land, queryClient],
  );

  return useMemo(
    () => ({ launches, error, clearError, archive, setLocate, archiveAll }),
    [launches, error, clearError, archive, setLocate, archiveAll],
  );
}
