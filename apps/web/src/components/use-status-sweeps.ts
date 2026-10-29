import type { Task } from "@blackwall/shared";
import { useCallback, useState } from "react";
import { statusMap } from "../agent-dots";
import { nextSweeps, statusChanges } from "../inbox";

/**
 * The status sweep on an inbox card (`.bw-status-sweep`) as its task changes
 * status, as a counter per task id. The first tasks snapshot only seeds the
 * statuses, so a reload or the inbox's first load never sweeps; each later
 * snapshot sweeps the shown cards whose status changed. A card that is not
 * shown (filtered out, crumbling, archived or gone) never gets a sweep and
 * loses the one it had, so showing it again does not replay. The card keys the
 * sweep on its counter, so a new change remounts it and replays the
 * animation; `end` drops the sweep on `animationend`, so a later remount (the
 * card moving group) does not replay either. Under reduced motion the sweep is
 * hidden and never ends, so it stays, unseen, until the card is hidden.
 */
export function useStatusSweeps(
  tasks: readonly Task[],
  shownIds: readonly string[],
): { sweeps: ReadonlyMap<string, number>; end: (taskId: string, sweep: number) => void } {
  const [sweeps, setSweeps] = useState<ReadonlyMap<string, number>>(new Map());

  // Statuses and shown cards seen so far, compared on each update.
  const shownKey = shownIds.join(" ");
  const [seenTasks, setSeenTasks] = useState(tasks);
  const [statuses, setStatuses] = useState(() => statusMap(tasks));
  const [seenShown, setSeenShown] = useState(shownKey);
  if (tasks !== seenTasks || shownKey !== seenShown) {
    const changed = tasks !== seenTasks ? statusChanges(statuses, tasks) : [];
    if (tasks !== seenTasks) {
      setSeenTasks(tasks);
      setStatuses(statusMap(tasks));
    }
    setSeenShown(shownKey);
    const next = nextSweeps(sweeps, changed, new Set(shownIds));
    if (next.size !== sweeps.size || [...next].some(([id, n]) => sweeps.get(id) !== n)) {
      setSweeps(next);
    }
  }

  const end = useCallback((taskId: string, sweep: number) => {
    setSweeps((prev) => {
      if (prev.get(taskId) !== sweep) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  return { sweeps, end };
}
