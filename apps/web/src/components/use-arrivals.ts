import type { Task } from "@blackwall/shared";
import { useCallback, useState } from "react";
import { newTaskIds, nextArrivals } from "../inbox";

/**
 * The inbox cards arriving (`animate-arrive` and a title decrypt), by task id.
 * The first tasks snapshot only seeds the ids seen, archived ones included, so
 * a reload or the inbox's first load never animates; each later snapshot
 * arrives the shown cards of tasks never seen before. A card that is not shown
 * (filtered out, crumbling or gone) never arrives and loses the arrival it had,
 * so showing it again does not replay. `end` drops the arrival on
 * `animationend`, so a later remount (the card moving group) does not replay
 * either. Under reduced motion the slide never runs and never ends, so the
 * arrival stays, unseen, until the card is hidden.
 */
export function useArrivals(
  tasks: readonly Task[],
  shownIds: readonly string[],
): { arrivals: ReadonlySet<string>; end: (taskId: string) => void } {
  const [arrivals, setArrivals] = useState<ReadonlySet<string>>(new Set());

  // Task ids and shown cards seen so far, compared on each update.
  const shownKey = shownIds.join(" ");
  const [seenTasks, setSeenTasks] = useState(tasks);
  const [seenIds, setSeenIds] = useState<ReadonlySet<string>>(
    () => new Set(tasks.map((t) => t.id)),
  );
  const [seenShown, setSeenShown] = useState(shownKey);
  if (tasks !== seenTasks || shownKey !== seenShown) {
    const added = tasks !== seenTasks ? newTaskIds(seenIds, tasks) : [];
    if (tasks !== seenTasks) {
      setSeenTasks(tasks);
      if (tasks.some((t) => !seenIds.has(t.id))) {
        setSeenIds(new Set([...seenIds, ...tasks.map((t) => t.id)]));
      }
    }
    setSeenShown(shownKey);
    const next = nextArrivals(arrivals, added, new Set(shownIds));
    if (next.size !== arrivals.size || [...next].some((id) => !arrivals.has(id))) {
      setArrivals(next);
    }
  }

  const end = useCallback((taskId: string) => {
    setArrivals((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  return { arrivals, end };
}
