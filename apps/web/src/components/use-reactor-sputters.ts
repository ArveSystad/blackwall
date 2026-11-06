import type { ProjectRun } from "@blackwall/shared";
import { useEffect, useRef, useState } from "react";
import { REACTOR_SPUTTER_MS, reactorSputters, reactorVisual, runStatusMap } from "../reactor";

/**
 * The red sputter at a repo's tower (`GridReactors`) as its project run
 * crashes, by repo id; the count is bumped per sputter and goes in the React
 * key, so a new one replays. The first loaded runs snapshot only seeds the
 * statuses, so a reload or a remount never sputters. A sputter is dropped
 * after `REACTOR_SPUTTER_MS` (a timeout, since reduced motion turns the
 * animation off), or at once when a new run starts on that repo.
 */
export function useReactorSputters(
  runs: readonly ProjectRun[] | undefined,
): ReadonlyMap<string, number> {
  const [sputters, setSputters] = useState<ReadonlyMap<string, number>>(new Map());
  const timers = useRef(new Map<string, { count: number; timer: number }>());

  // Runs seen so far; null until the first loaded snapshot, which only seeds.
  const [seenRuns, setSeenRuns] = useState(runs);
  const [statuses, setStatuses] = useState(() => (runs ? runStatusMap(runs) : null));
  if (runs !== seenRuns) {
    setSeenRuns(runs);
    if (runs) {
      setStatuses(runStatusMap(runs));
      if (statuses) {
        const crashed = reactorSputters(statuses, runs);
        // A restart replaces the repo's sputter with its pylon.
        const restarted = runs
          .filter((run) => sputters.has(run.repoId) && reactorVisual(run.status) !== null)
          .map((run) => run.repoId);
        if (crashed.length > 0 || restarted.length > 0) {
          const next = new Map(sputters);
          for (const repoId of restarted) next.delete(repoId);
          for (const repoId of crashed) next.set(repoId, (sputters.get(repoId) ?? 0) + 1);
          setSputters(next);
        }
      }
    }
  }

  useEffect(() => {
    for (const [repoId, scheduled] of timers.current) {
      if (sputters.get(repoId) === scheduled.count) continue;
      window.clearTimeout(scheduled.timer);
      timers.current.delete(repoId);
    }
    for (const [repoId, count] of sputters) {
      if (timers.current.get(repoId)?.count === count) continue;
      const timer = window.setTimeout(() => {
        timers.current.delete(repoId);
        setSputters((prev) => {
          if (prev.get(repoId) !== count) return prev;
          const next = new Map(prev);
          next.delete(repoId);
          return next;
        });
      }, REACTOR_SPUTTER_MS);
      timers.current.set(repoId, { count, timer });
    }
  }, [sputters]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const { timer } of running.values()) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  return sputters;
}
