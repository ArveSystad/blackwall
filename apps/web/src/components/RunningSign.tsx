import { useEffect, useRef, useState } from "react";
import { activeAgentsSuffix, runningLabelSuffix } from "../agent-dots";
import { DecryptGlyphs } from "./DecryptText";
import { useDecrypt } from "./use-decrypt";

/** Replays a decrypt for each change of `count` after the first render. */
function useCountDecrypt(count: number): string | null {
  const [seen, setSeen] = useState(count);
  const [play, setPlay] = useState<number | null>(null);
  if (count !== seen) {
    setSeen(count);
    setPlay((p) => (p ?? 0) + 1);
  }
  return useDecrypt(String(count), play);
}

/**
 * The home grid's neon sign: "N tasks running" over "M agents active". It
 * hangs just left of centre, its bottom edge just above the horizon, tilted in
 * perspective (rotated toward the centre from its right edge) and floating a
 * few pixels up and down (`--animate-sign-float`; at rest under reduced
 * motion). It sits over `GridBackdrop` and under the pane's z-10 content (dots,
 * cards, messages), and ships (GridShots, -z-10) fly behind it.
 * Lit (`data-lit`, cyan neon) while any task runs; unlit and click-through at
 * 0. When the grid's centre column fades (`faded`), the whole sign dims evenly
 * to `--grid-fade` with the same ease, since a mask would half-dim it across
 * the ramp.
 * The pointer brightens the text around the cursor through `--mx`/`--my` and
 * `data-hover`. The text's children take no pointer events, so the grid is
 * always the target and `offsetX`/`offsetY` are in its own tilted space,
 * which `getBoundingClientRect` (the projected box) is not.
 * Each number decrypts on change (`useDecrypt`); both copies share its frame.
 * The parent must be `relative`.
 */
export function RunningSign({
  tasks,
  agents,
  faded,
}: {
  tasks: number;
  agents: number;
  faded: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lit = tasks > 0;
  const tasksFrame = useCountDecrypt(tasks);
  const agentsFrame = useCountDecrypt(agents);

  useEffect(() => {
    const text = ref.current;
    if (!text) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      text.style.setProperty("--mx", `${x}px`);
      text.style.setProperty("--my", `${y}px`);
      // Set with the coordinates so the glow never shows at a stale spot.
      text.dataset.hover = "";
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.target !== text) return;
      x = event.offsetX;
      y = event.offsetY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const leave = () => {
      // A frame queued by the last move must not relight it after leaving.
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      delete text.dataset.hover;
    };
    text.addEventListener("pointermove", move, { passive: true });
    text.addEventListener("pointerleave", leave, { passive: true });
    return () => {
      text.removeEventListener("pointermove", move);
      text.removeEventListener("pointerleave", leave);
      if (frame) cancelAnimationFrame(frame);
      // Going unlit stops pointer events, so no leave would clear it.
      delete text.dataset.hover;
    };
  }, [lit]);

  const tasksNumber = String(tasks);
  const agentsNumber = String(agents);
  const lines = (spoken: boolean) => (
    <>
      <span>
        <DecryptGlyphs text={tasksNumber} frame={tasksFrame} />
        {runningLabelSuffix(tasks)}
        {spoken && <span className="sr-only">, </span>}
      </span>
      <span>
        <DecryptGlyphs text={agentsNumber} frame={agentsFrame} />
        {activeAgentsSuffix(agents)}
      </span>
    </>
  );
  return (
    <div
      className="bw-sign-layer pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      data-full={faded ? undefined : ""}
    >
      <div className="absolute right-[calc(50%+32px)] bottom-[calc(42%+28px)] max-w-[calc(50%-48px)] animate-sign-float">
        <div className="perspective-[700px]">
          <div className="bw-sign" data-lit={lit ? "" : undefined} role="status">
            <div
              ref={ref}
              className="bw-running font-sans text-[clamp(16px,2.2vw,26px)] leading-[1.3] font-semibold tracking-[0.18em] whitespace-nowrap uppercase"
            >
              <span className="bw-running-base">{lines(true)}</span>
              <span className="bw-running-hot" aria-hidden="true">
                {lines(false)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
