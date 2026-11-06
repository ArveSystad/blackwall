import type { Task } from "@blackwall/shared";
import { useEffect, useRef, useState } from "react";
import { SATELLITE_FLASH_MS, satelliteChanges, satelliteMap } from "../ci-satellite";

/**
 * The one-shot flash on a grid dot's CI satellite (`GridAgents`) as its CI
 * result changes, by task id: a count bumped per change, part of the flash's
 * React key so a second change replays it. The first tasks snapshot only
 * seeds the tones, so a reload or a remount never flashes. A flash is dropped
 * after `SATELLITE_FLASH_MS` (a timeout, since reduced motion turns the
 * animation off and no `animationend` arrives).
 */
export function useCiFlashes(tasks: ReadonlyMap<string, Task>): ReadonlyMap<string, number> {
  const [flashes, setFlashes] = useState<ReadonlyMap<string, number>>(new Map());
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const timers = useRef(new Map<string, { count: number; timer: number }>());

  // Tones seen so far, compared on each tasks update; a new tone flashes that task.
  const [seenTasks, setSeenTasks] = useState(tasks);
  const [tones, setTones] = useState(() => satelliteMap(tasks.values()));
  if (tasks !== seenTasks) {
    setSeenTasks(tasks);
    setTones(satelliteMap(tasks.values()));
    const changed = satelliteChanges(tones, [...tasks.values()]);
    if (changed.length > 0) {
      const nextCounts = new Map(counts);
      const nextFlashes = new Map(flashes);
      for (const id of changed) {
        const count = (nextCounts.get(id) ?? 0) + 1;
        nextCounts.set(id, count);
        nextFlashes.set(id, count);
      }
      setCounts(nextCounts);
      setFlashes(nextFlashes);
    }
  }

  useEffect(() => {
    for (const [taskId, count] of flashes) {
      const scheduled = timers.current.get(taskId);
      if (scheduled?.count === count) continue;
      if (scheduled) window.clearTimeout(scheduled.timer);
      const timer = window.setTimeout(() => {
        timers.current.delete(taskId);
        setFlashes((prev) => {
          if (prev.get(taskId) !== count) return prev;
          const next = new Map(prev);
          next.delete(taskId);
          return next;
        });
      }, SATELLITE_FLASH_MS);
      timers.current.set(taskId, { count, timer });
    }
  }, [flashes]);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const { timer } of running.values()) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  return flashes;
}
