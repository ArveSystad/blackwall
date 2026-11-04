import { useEffect, useRef } from "react";
import { useShots } from "./use-shots";

/**
 * "Shooting" the grid wall: a press of the main button on blank space in the
 * parent fires a short cyan shot at the cursor (a flash, a faint bloom and a
 * ring; `.bw-shot` in styles.css). Purely visual; skipped under reduced motion.
 * Blank space means the parent itself was hit: content that should not shoot
 * must be the event target (pointer events on), and overlays that should let
 * shots through must be `pointer-events-none`. The listener is native on the
 * DOM parent, so clicks in portalled dialogs never reach it.
 * The parent must be `relative` and form a stacking context (Home's
 * `relative z-10`); the layer paints under the pane's content through `-z-10`.
 */
export function GridShots() {
  const ref = useRef<HTMLDivElement>(null);
  const { shots, fire } = useShots();

  useEffect(() => {
    const layer = ref.current;
    const parent = layer?.parentElement;
    if (!layer || !parent) return;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== parent) return;
      const rect = layer.getBoundingClientRect();
      fire(event.clientX - rect.left, event.clientY - rect.top);
    };
    parent.addEventListener("pointerdown", down);
    return () => parent.removeEventListener("pointerdown", down);
  }, [fire]);

  return (
    <div
      ref={ref}
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      aria-hidden="true"
    >
      {shots.map((shot) => (
        <span key={shot.id} className="bw-boom bw-shot" style={{ left: shot.x, top: shot.y }}>
          <span className="bw-shot-flash" />
        </span>
      ))}
    </div>
  );
}
