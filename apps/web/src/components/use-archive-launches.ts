import type { Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { archiveTask } from "../api";
import { queryKeys } from "../query";
import { errorMessage } from "../settings-forms";

/** How long an archived done dot flies to the horizon; mirrors `.bw-launch` in styles.css. */
export const LAUNCH_MS = 900;

/** Done dots being archived, and the last archive error; see `useArchiveLaunches`. */
export interface ArchiveLaunches {
  /** The spot each archived dot launched from, by task id, until it lands. */
  launches: ReadonlyMap<string, { x: number; y: number }>;
  error: string | null;
  /** Archives a done task and launches its dot from `x`, `y`. */
  archive: (task: Task, x: number, y: number) => void;
}

/**
 * Archiving done dots from the grid (`GridAgents`). The request fires at once;
 * a launch is dropped after `LAUNCH_MS` (a timeout, since reduced motion turns
 * the animation off) or as soon as its request fails, which brings the dot
 * back. Kept by the grid's owner, so the last dot's flight outlives the dot.
 */
export function useArchiveLaunches(): ArchiveLaunches {
  const queryClient = useQueryClient();
  const [launches, setLaunches] = useState<ReadonlyMap<string, { x: number; y: number }>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const timers = useRef(new Map<string, number>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
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

  return useMemo(() => ({ launches, error, archive }), [launches, error, archive]);
}
