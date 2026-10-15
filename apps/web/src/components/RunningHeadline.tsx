import { useEffect, useRef, useState } from "react";
import { runningLabelSuffix } from "../agent-dots";
import { DecryptGlyphs } from "./DecryptText";
import { useDecrypt } from "./use-decrypt";

/**
 * The agents view's centred "N tasks running" headline, drawn while any task
 * runs; nothing at 0. Its neon marks the running state, so it is running cyan
 * with `--glow-text-cyan`, like the running dots. It sits just above the
 * horizon, over `GridBackdrop` and under `GridAgents` (z-10), so dots and their
 * cards draw on top of it.
 * The pointer brightens the text around the cursor, driven by `--mx`/`--my` and
 * `data-hover` from the text's own pointer events; those moves are the only JS.
 * Everything else is pure CSS (see `.bw-running*` in styles.css).
 * When the count changes, its number decrypts (`useDecrypt`); both copies
 * share the one frame, so the pointer-glow copy matches exactly.
 * The parent must be `relative`.
 */
export function RunningHeadline({ count }: { count: number }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const shown = count > 0;
  const [seenCount, setSeenCount] = useState(count);
  const [play, setPlay] = useState<number | null>(null);

  // Each count change after the first render plays the number's decrypt;
  // 0 → N too, since the headline stays mounted while it draws nothing.
  if (count !== seenCount) {
    setSeenCount(count);
    setPlay((p) => (p ?? 0) + 1);
  }
  const frame = useDecrypt(String(count), play);

  useEffect(() => {
    const text = ref.current;
    if (!text) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      const rect = text.getBoundingClientRect();
      text.style.setProperty("--mx", `${x - rect.left}px`);
      text.style.setProperty("--my", `${y - rect.top}px`);
      // Set with the coordinates so the glow never shows at a stale spot.
      text.dataset.hover = "";
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
      delete text.dataset.hover;
    };
    text.addEventListener("pointermove", move, { passive: true });
    text.addEventListener("pointerleave", leave, { passive: true });
    return () => {
      text.removeEventListener("pointermove", move);
      text.removeEventListener("pointerleave", leave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [shown]);

  if (!shown) return null;
  const number = String(count);
  const suffix = runningLabelSuffix(count);
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center px-6">
      <p
        ref={ref}
        className="bw-running pointer-events-auto relative m-0 text-center font-sans text-[clamp(28px,5vw,40px)] leading-[1.2] font-semibold tracking-[0.18em] uppercase"
      >
        <span className="bw-running-base">
          <DecryptGlyphs text={number} frame={frame} />
          {suffix}
        </span>
        <span className="bw-running-hot" aria-hidden="true">
          <DecryptGlyphs text={number} frame={frame} />
          {suffix}
        </span>
      </p>
    </div>
  );
}
