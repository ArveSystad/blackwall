import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../reduced-motion";
import {
  MAX_SHIPS,
  SHIP_BOOM_MS,
  hitShip,
  makeShip,
  makeShipBoom,
  shipGapMs,
  type Ship,
  type ShipBoom,
  type ShipTarget,
} from "../ships";

/**
 * The ships crossing the Home grid's sky (`GridShots`) and their explosions.
 * One spawns after a fresh random gap (`shipGapMs`) when none is flying and
 * the tab is visible, and is dropped after its `durationMs` (its inline
 * `--ship-duration`), when it rests off-screen. `strike(x, y, rect)` downs the
 * first ship whose body (registered through `registerBody`, which reads
 * `data-ship-id`) is at `x`/`y` in the layer whose box is `rect`, and adds a
 * boom there, dropped after `SHIP_BOOM_MS`. Cleanup clears every timer, so
 * StrictMode's replay is safe. Reduced motion (read on mount) never spawns.
 *
 * `registerBody` and `strike` must keep a stable identity (refs only, no
 * state): GridShots' listener effect depends on them, and its cleanup ends a
 * held trigger.
 */
export function useShips(): {
  ships: readonly Ship[];
  booms: readonly ShipBoom[];
  registerBody: (el: HTMLElement | null) => (() => void) | undefined;
  strike: (x: number, y: number, rect: DOMRect) => void;
} {
  const [ships, setShips] = useState<readonly Ship[]>([]);
  const [booms, setBooms] = useState<readonly ShipBoom[]>([]);
  const nextId = useRef(0);
  const nextBoomId = useRef(0);
  // The ships in flight: their mounted bodies and their drop timers.
  const bodies = useRef(new Map<number, HTMLElement>());
  const dropTimers = useRef(new Map<number, number>());
  const boomTimers = useRef(new Set<number>());

  useEffect(() => {
    const drops = dropTimers.current;
    const boomsRunning = boomTimers.current;
    let timer = 0;
    if (!prefersReducedMotion()) {
      const schedule = () => {
        timer = window.setTimeout(() => {
          if (!document.hidden && drops.size < MAX_SHIPS) {
            const ship = makeShip(nextId.current++);
            setShips((prev) => [...prev, ship]);
            const drop = window.setTimeout(() => {
              drops.delete(ship.id);
              setShips((prev) => prev.filter((s) => s.id !== ship.id));
            }, ship.durationMs);
            drops.set(ship.id, drop);
          }
          schedule();
        }, shipGapMs());
      };
      schedule();
    }
    return () => {
      window.clearTimeout(timer);
      for (const drop of drops.values()) window.clearTimeout(drop);
      drops.clear();
      for (const boom of boomsRunning) window.clearTimeout(boom);
      boomsRunning.clear();
    };
  }, []);

  const registerBody = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const id = Number(el.dataset.shipId);
    const map = bodies.current;
    map.set(id, el);
    return () => {
      if (map.get(id) === el) map.delete(id);
    };
  }, []);

  const strike = useCallback((x: number, y: number, rect: DOMRect) => {
    const targets: ShipTarget[] = [];
    for (const [id, el] of bodies.current) {
      const box = el.getBoundingClientRect();
      targets.push({
        id,
        left: box.left - rect.left,
        top: box.top - rect.top,
        right: box.right - rect.left,
        bottom: box.bottom - rect.top,
      });
    }
    const id = hitShip(targets, x, y);
    if (id === null) return;
    const hit = targets.find((t) => t.id === id);
    const el = bodies.current.get(id);
    if (!hit || !el) return;
    // Out of reach at once, so the next auto-fire shot can't down it again.
    bodies.current.delete(id);
    window.clearTimeout(dropTimers.current.get(id));
    dropTimers.current.delete(id);
    setShips((prev) => prev.filter((s) => s.id !== id));

    const scale = Number(el.dataset.shipScale) || 1;
    const boom = makeShipBoom(
      nextBoomId.current++,
      (hit.left + hit.right) / 2,
      (hit.top + hit.bottom) / 2,
      scale,
    );
    setBooms((prev) => [...prev, boom]);
    const timer = window.setTimeout(() => {
      boomTimers.current.delete(timer);
      setBooms((prev) => prev.filter((b) => b.id !== boom.id));
    }, SHIP_BOOM_MS);
    boomTimers.current.add(timer);
  }, []);

  return { ships, booms, registerBody, strike };
}
