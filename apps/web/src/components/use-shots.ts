import { useCallback, useEffect, useRef, useState } from "react";
import { SHOT_MS, addShot, type Shot } from "../shots";

/**
 * The shots fired at the grid wall (`GridShots`). `fire(x, y)` adds one,
 * keeping at most `MAX_SHOTS`, and drops it after `SHOT_MS`. Under reduced
 * motion it does nothing, since the CSS would hide the shot anyway.
 */
export function useShots(): { shots: readonly Shot[]; fire: (x: number, y: number) => void } {
  const [shots, setShots] = useState<readonly Shot[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());

  const fire = useCallback((x: number, y: number) => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = nextId.current++;
    setShots((prev) => addShot(prev, { id, x, y }));
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
