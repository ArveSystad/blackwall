import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";

/**
 * Decorative resting background of the empty main pane (first-run setup steps,
 * "Nothing on deck" or the active agents; never behind a task view, Settings or
 * modals): a perspective floor that drifts toward the viewer, a horizon glow and
 * a slow scanline (dark only). `GridAgents` draws the active agents as dots on
 * top of it. Also the full-page Stats screen's background.
 * By default the lines fade under a ~520px centre column (`calc(50% ± 260px)`)
 * so centred content stays readable; keep such content within it. `fade={false}`
 * runs the grid full width (the agents view); switching between the two eases.
 * A pointer spotlight brightens the lines around the cursor (dark) or subtly
 * darkens them (light), driven by `--mx`/`--my` from the parent's pointer
 * events; those moves are the only JS. Everything else is pure CSS (see
 * `.bw-grid*` in styles.css).
 * A film overlay (`.bw-film`) covers the whole pane above its content (`z-30`):
 * grain evenly over everything, plus a faint flicker at long, irregular
 * intervals (two coprime CSS loops, 23s and 37s, that dim everything toward
 * `--bg-0`). Under reduced motion the grain freezes and the flicker stops.
 * The parent must be `relative` and `isolate` (so the overlay stays within the
 * pane and below portalled dialogs), and must not scroll: put scrolling content
 * in a sibling, so the backdrop stays fixed. Pane content must stay below `z-30`.
 */
export function GridBackdrop({ fade = true }: { fade?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = ref.current;
    const parent = grid?.parentElement;
    if (!grid || !parent) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      const rect = grid.getBoundingClientRect();
      grid.style.setProperty("--mx", `${x - rect.left}px`);
      grid.style.setProperty("--my", `${y - rect.top}px`);
      // Set with the coordinates so the spotlight never shows at a stale spot.
      grid.dataset.hover = "";
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const leave = () => {
      // A frame queued by the last move must not relight it after leaving.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      delete grid.dataset.hover;
    };
    parent.addEventListener("pointermove", move, { passive: true });
    parent.addEventListener("pointerleave", leave, { passive: true });
    return () => {
      parent.removeEventListener("pointermove", move);
      parent.removeEventListener("pointerleave", leave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div ref={ref} className={cn("bw-grid", !fade && "bw-grid-full")} aria-hidden="true">
        <div className="bw-grid-sky" />
        <div className="bw-grid-glow" />
        <div className="bw-grid-floor">
          <div className="bw-grid-plane" />
        </div>
        <div className="bw-grid-horizon" />
        <div className="bw-grid-scan" />
        <div className="bw-grid-spot" />
      </div>
      <div className="bw-film" aria-hidden="true">
        <div className="bw-film-grain" />
        <div className="bw-film-flicker-a" />
        <div className="bw-film-flicker-b" />
      </div>
    </>
  );
}
