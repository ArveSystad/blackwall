import { browserClock, type DecryptClock } from "./decrypt";

/** The slowest a streamed reply reveals, in characters per ms. JS only: no CSS mirrors it. */
export const STREAM_CHARS_PER_MS = 0.4;
/** A backlog of any size is revealed within about this long. JS only. */
export const STREAM_CATCHUP_MS = 600;
/** How many of the last visible characters still show glyphs. JS only. */
export const STREAM_TAIL_CHARS = 16;
/** Frames go out at most this often. JS only. */
export const STREAM_TICK_MS = 40;
/** The glyphs of the unsettled tail: none that markdown reads (`\ < > /`). JS only. */
export const STREAM_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789▓░";

const glyphs = Array.from(STREAM_GLYPHS);

/** Only letters and digits scramble, so markdown punctuation and whitespace keep their shape. */
const SCRAMBLES = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

/**
 * Moves the reveal cursor `dtMs` on. It runs at `STREAM_CHARS_PER_MS`, or
 * faster to clear the backlog within `STREAM_CATCHUP_MS`; `pace` carries that
 * faster rate between steps so a catch-up really ends in time. Both come back
 * reset once the cursor reaches the target.
 */
export function advanceReveal(
  shown: number,
  targetLength: number,
  dtMs: number,
  pace = 0,
): { shown: number; pace: number } {
  const backlog = targetLength - shown;
  if (backlog <= 0) return { shown: targetLength, pace: 0 };
  const rate = Math.max(STREAM_CHARS_PER_MS, backlog / STREAM_CATCHUP_MS, pace);
  const next = Math.min(targetLength, shown + rate * Math.max(0, dtMs));
  return { shown: next, pace: next >= targetLength ? 0 : rate };
}

/**
 * The reveal frame with `shown` characters of `target` out: the visible end
 * snaps forward to the end of its word, and the last `STREAM_TAIL_CHARS`
 * visible letters and digits show glyphs. Exactly `target` once all is shown.
 */
export function revealFrame(
  target: string,
  shown: number,
  random: () => number = Math.random,
): string {
  if (shown >= target.length) return target;
  let end = Math.max(0, Math.floor(shown));
  while (end < target.length && end > 0 && !SPACE.test(target[end] ?? "")) end++;
  const chars = Array.from(target.slice(0, end));
  const tail = chars.length - STREAM_TAIL_CHARS;
  return chars
    .map((char, i) =>
      i >= tail && SCRAMBLES.test(char)
        ? glyphs[Math.floor(random() * glyphs.length) % glyphs.length]
        : char,
    )
    .join("");
}

/**
 * How much of `final` a reveal can skip after `draft` was shown: their common
 * prefix, snapped back to a word start unless it is all of `final`.
 */
export function commonPrefixLength(draft: string, final: string): number {
  const max = Math.min(draft.length, final.length);
  let i = 0;
  while (i < max && draft[i] === final[i]) i++;
  if (i === final.length) return i;
  while (i > 0 && !SPACE.test(final[i - 1] ?? "")) i--;
  return i;
}

/**
 * Plays a reveal of a target that may keep growing: from `from` characters,
 * each frame advances the cursor (see {@link advanceReveal}) and passes
 * `revealFrame(getTarget(), …)` to `onFrame`, at most every `STREAM_TICK_MS`.
 * Once the cursor reaches the target it calls `onCaughtUp` with the length
 * shown and stops. Returns a cancel that stops it without calling `onCaughtUp`.
 */
export function runReveal({
  getTarget,
  from,
  onFrame,
  onCaughtUp,
  clock = browserClock,
  random = Math.random,
}: {
  getTarget: () => string;
  from: number;
  onFrame: (frame: string) => void;
  onCaughtUp: (length: number) => void;
  clock?: DecryptClock;
  random?: () => number;
}): () => void {
  let shown = from;
  let pace = 0;
  let last = clock.now();
  let framed = -Infinity;
  let id: number | null = null;
  const tick = () => {
    const now = clock.now();
    const target = getTarget();
    ({ shown, pace } = advanceReveal(shown, target.length, now - last, pace));
    last = now;
    if (shown >= target.length) {
      id = null;
      onCaughtUp(target.length);
      return;
    }
    if (now - framed >= STREAM_TICK_MS) {
      framed = now;
      onFrame(revealFrame(target, shown, random));
    }
    id = clock.request(tick);
  };
  id = clock.request(tick);
  return () => {
    if (id !== null) clock.cancel(id);
    id = null;
  };
}
