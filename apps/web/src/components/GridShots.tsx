import { useEffect, useRef, type CSSProperties } from "react";
import { prefersReducedMotion } from "../reduced-motion";
import {
  RECOIL_MS,
  SHOT_EVENT,
  advanceTrigger,
  aimTrigger,
  pullTrigger,
  type ShotEventDetail,
  type Trigger,
} from "../shots";
import { Spaceship } from "./Spaceship";
import { useShips } from "./use-ships";
import { useShots } from "./use-shots";

/**
 * "Shooting" the grid wall: a press of the main button on blank space in the
 * parent fires a cyan shot at the cursor (a star-shaped muzzle flash, a bloom,
 * a shock ring, sparks and a fading impact mark; `.bw-shot*` in styles.css),
 * and holding it auto-fires about nine shots a second at the moving pointer
 * until release, leaving the parent or the window losing focus. Each shot
 * also dispatches `SHOT_EVENT` so GridBackdrop flares and shakes the grid, and
 * kicks the crosshair cursor back (`data-recoil` on the parent for `RECOIL_MS`).
 * Every 15–45s a ship crosses the sky above the horizon at a random depth
 * (farther is smaller, dimmer, slower and lower; `useShips`, `.bw-ship*`);
 * a shot on one downs it in a big yellow explosion (`.bw-ship-boom`), and a
 * held trigger keeps firing through it.
 * Purely visual; skipped under reduced motion.
 * Blank space means the parent itself was hit: content that should not shoot
 * must be the event target (pointer events on), and overlays that should let
 * shots through must be `pointer-events-none`. Only the press must be on blank
 * space; a held trigger keeps firing over content, since shots draw under it.
 * The listener is native on the DOM parent, so clicks in portalled dialogs
 * never reach it. The press is not cancelled, so it still blurs and clears
 * selections as before; text selection is off only while held, through
 * `data-firing` on the parent.
 * The parent must carry `bw-shoot` (the crosshair cursor over its blank
 * space), be `relative` and form a stacking context (Home's `relative z-10`);
 * the layer paints under the pane's content through `-z-10`.
 */
export function GridShots() {
  const ref = useRef<HTMLDivElement>(null);
  const { shots, fire } = useShots();
  const { ships, booms, registerBody, strike } = useShips();

  useEffect(() => {
    const layer = ref.current;
    const parent = layer?.parentElement;
    if (!layer || !parent) return;
    let trigger: Trigger | null = null;
    let frame = 0;
    let recoil = 0;

    const shoot = (x: number, y: number) => {
      const rect = layer.getBoundingClientRect();
      fire(x, y);
      strike(x, y, rect);
      const detail: ShotEventDetail = { clientX: x + rect.left, clientY: y + rect.top };
      layer.dispatchEvent(new CustomEvent(SHOT_EVENT, { bubbles: true, detail }));
      parent.dataset.recoil = "";
      window.clearTimeout(recoil);
      recoil = window.setTimeout(() => delete parent.dataset.recoil, RECOIL_MS);
    };
    const tick = () => {
      if (!trigger) return;
      const next = advanceTrigger(trigger, performance.now());
      trigger = next.trigger;
      if (next.fire) shoot(trigger.x, trigger.y);
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      trigger = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      delete parent.dataset.firing;
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== parent) return;
      if (prefersReducedMotion()) return;
      // Set before the browser's default action, so the drag never selects text.
      parent.dataset.firing = "";
      const rect = layer.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (frame) cancelAnimationFrame(frame);
      trigger = pullTrigger(x, y, performance.now());
      shoot(x, y);
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!trigger) return;
      const rect = layer.getBoundingClientRect();
      trigger = aimTrigger(trigger, event.clientX - rect.left, event.clientY - rect.top);
    };

    parent.addEventListener("pointerdown", down);
    parent.addEventListener("pointermove", move, { passive: true });
    parent.addEventListener("pointerleave", stop);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      parent.removeEventListener("pointerdown", down);
      parent.removeEventListener("pointermove", move);
      parent.removeEventListener("pointerleave", stop);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      stop();
      window.clearTimeout(recoil);
      delete parent.dataset.recoil;
    };
  }, [fire, strike]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {ships.map((ship) => (
        <div
          key={ship.id}
          className={ship.direction === "rtl" ? "bw-ship bw-ship-rtl" : "bw-ship"}
          style={
            {
              "--ship-y": `${ship.y}%`,
              "--ship-duration": `${ship.durationMs}ms`,
              "--ship-drift": `${ship.drift}px`,
              "--ship-scale": ship.scale,
              "--ship-color": ship.hue,
              opacity: ship.opacity,
            } as CSSProperties
          }
        >
          <div
            ref={registerBody}
            className="bw-ship-body"
            data-ship-id={ship.id}
            data-ship-scale={ship.scale}
          >
            <Spaceship lights={ship.lights} />
          </div>
        </div>
      ))}
      {booms.map((boom) => (
        <span
          key={boom.id}
          className="bw-boom bw-ship-boom"
          style={{ left: boom.x, top: boom.y, "--boom-scale": boom.scale } as CSSProperties}
        >
          <span className="bw-ship-boom-core" />
          {boom.sparks.map((spark, i) => (
            <span
              key={i}
              className="bw-shot-spark"
              style={
                {
                  "--spark-angle": `${spark.angle}deg`,
                  "--spark-reach": `${spark.reach}px`,
                  "--spark-length": `${spark.length}px`,
                  "--spark-delay": `${spark.delay}ms`,
                } as CSSProperties
              }
            />
          ))}
        </span>
      ))}
      {shots.map((shot) => (
        <span
          key={shot.id}
          className="bw-boom bw-shot"
          style={{ left: shot.x, top: shot.y, "--shot-angle": `${shot.angle}deg` } as CSSProperties}
        >
          <span className="bw-shot-mark" />
          <span className="bw-shot-flash" />
          {shot.sparks.map((spark, i) => (
            <span
              key={i}
              className="bw-shot-spark"
              style={
                {
                  "--spark-angle": `${spark.angle}deg`,
                  "--spark-reach": `${spark.reach}px`,
                  "--spark-length": `${spark.length}px`,
                  "--spark-delay": `${spark.delay}ms`,
                } as CSSProperties
              }
            />
          ))}
        </span>
      ))}
    </div>
  );
}
