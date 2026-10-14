import type { Task } from "@blackwall/shared";
import { useEffect, useRef, useState } from "react";
import {
  SUPERNOVA_STAGGER_MS,
  doneTransitions,
  statusMap,
  supernovaLifetimeMs,
} from "../agent-dots";

/** One supernova on a dot that just turned done. */
export interface Supernova {
  /** Bumped once per tasks snapshot that starts bursts; part of the React key, so a new burst replays. */
  batch: number;
  /** Stagger within the burst's snapshot, as `--supernova-delay`. */
  delayMs: number;
}

/**
 * The green supernova on a grid dot (`GridAgents`) as its task turns done. The
 * first tasks snapshot only seeds the statuses, so a reload or a remount never
 * bursts; each later snapshot bursts the tasks that turned done in it, the
 * i-th after `i × SUPERNOVA_STAGGER_MS`. A burst is dropped after its delay
 * plus `SUPERNOVA_MS`, or `SUPERNOVA_FLASH_MS` under reduced motion, where the
 * CSS shows only a static core (a timeout, since reduced motion turns the
 * animation off).
 */
export function useSupernovas(tasks: ReadonlyMap<string, Task>): ReadonlyMap<string, Supernova> {
  const [bursts, setBursts] = useState<ReadonlyMap<string, Supernova>>(new Map());
  const [batch, setBatch] = useState(0);
  const timers = useRef(new Map<string, { batch: number; timer: number }>());

  // Statuses seen so far, compared on each tasks update; a turn to done bursts that task.
  const [seenTasks, setSeenTasks] = useState(tasks);
  const [statuses, setStatuses] = useState(() => statusMap(tasks.values()));
  if (tasks !== seenTasks) {
    setSeenTasks(tasks);
    setStatuses(statusMap(tasks.values()));
    const done = doneTransitions(statuses, [...tasks.values()]);
    if (done.length > 0) {
      const next = new Map(bursts);
      done.forEach((id, i) =>
        next.set(id, { batch: batch + 1, delayMs: i * SUPERNOVA_STAGGER_MS }),
      );
      setBatch(batch + 1);
      setBursts(next);
    }
  }

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    for (const [taskId, burst] of bursts) {
      const scheduled = timers.current.get(taskId);
      if (scheduled?.batch === burst.batch) continue;
      if (scheduled) window.clearTimeout(scheduled.timer);
      const timer = window.setTimeout(
        () => {
          timers.current.delete(taskId);
          setBursts((prev) => {
            if (prev.get(taskId)?.batch !== burst.batch) return prev;
            const next = new Map(prev);
            next.delete(taskId);
            return next;
          });
        },
        burst.delayMs + supernovaLifetimeMs(reduced),
      );
      timers.current.set(taskId, { batch: burst.batch, timer });
    }
  }, [bursts]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const { timer } of running.values()) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  return bursts;
}
