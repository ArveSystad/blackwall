import { useEffect, useState } from "react";
import { ASSIGNED_BOOM_MS, boomsOnRise } from "../count-boom";

/** The last known count per pill, by its route; outlives Home unmounting while a task is open. */
const lastSeen = new Map<string, number>();

/**
 * The yellow assigned boom on a home pill (`CountPill`): booms once when the
 * known count rises from zero. `count` is null while loading or failed, which
 * keeps the last known count, so 0 → error → 3 still booms. Returns the
 * boom's counter (part of the React key, so a new boom replays the animation),
 * or null when none plays. A boom is dropped after `ASSIGNED_BOOM_MS` (a
 * timeout, since reduced motion turns the animation off). The last count lives
 * in a module map, so a rise while Home was unmounted booms on return.
 */
export function useCountBoom(key: string, count: number | null): number | null {
  const [seen, setSeen] = useState<number | null>(() => lastSeen.get(key) ?? null);
  const [boom, setBoom] = useState<number | null>(null);

  // On each new known count, a rise from zero starts (or replays) the boom.
  if (count !== null && count !== seen) {
    setSeen(count);
    if (boomsOnRise(seen, count)) setBoom((b) => (b ?? 0) + 1);
  }

  useEffect(() => {
    if (count !== null) lastSeen.set(key, count);
  }, [key, count]);

  useEffect(() => {
    if (boom === null) return;
    const timer = window.setTimeout(() => setBoom(null), ASSIGNED_BOOM_MS);
    return () => window.clearTimeout(timer);
  }, [boom]);

  return boom;
}
