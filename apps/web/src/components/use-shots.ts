import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../reduced-motion";
import { SHOT_MS, addShot, makeShot, type Shot } from "../shots";

/**
 * The shots fired at the grid wall (`GridShots`). `fire(x, y)` adds one with
 * a random flash rotation and spark spray, keeping at most `MAX_SHOTS`, and
 * drops it after `SHOT_MS` (its impact mark's fade). Under reduced motion it
 * does nothing, since the CSS would hide the shot anyway.
 */
export function useShots(): { shots: readonly Shot[]; fire: (x: number, y: number) => void } {
  const [shots, setShots] = useState<readonly Shot[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());

  const fire = useCallback((x: number, y: number) => {
    if (prefersReducedMotion()) return;
    const id = nextId.current++;
    const shot = makeShot(id, x, y);
    setShots((prev) => addShot(prev, shot));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setShots((prev) => prev.filter((shot) => shot.id !== id));
    }, SHOT_MS);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running) window.clearTimeout(timer);
      running.clear();
    };
  }, []);

  return { shots, fire };
}
