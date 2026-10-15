/** How long a decrypt takes to settle, left to right. JS only: no CSS mirrors it (see `.bw-decrypt*` in styles.css). */
export const DECRYPT_MS = 300;

/** The glyphs an unsettled character cycles through. */
export const DECRYPT_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789▓░/\\<>";

const glyphs = Array.from(DECRYPT_GLYPHS);

/** Whitespace is never scrambled, so words keep their shape while decrypting. */
function isSpace(char: string): boolean {
  return /\s/.test(char);
}

/**
 * The decrypt frame `elapsedMs` into the effect. Character `i` of `n` settles
 * once `elapsedMs >= ((i + 1) / n) * DECRYPT_MS`; the rest show a random glyph.
 * The frame has as many characters as `text` (surrogate pairs count as one),
 * and is exactly `text` from `DECRYPT_MS` on.
 */
export function decryptFrame(
  text: string,
  elapsedMs: number,
  random: () => number = Math.random,
): string {
  if (elapsedMs >= DECRYPT_MS) return text;
  const chars = Array.from(text);
  const n = chars.length;
  return chars
    .map((char, i) => {
      if (isSpace(char) || elapsedMs >= ((i + 1) / n) * DECRYPT_MS) return char;
      return glyphs[Math.floor(random() * glyphs.length) % glyphs.length];
    })
    .join("");
}

/** The frame at 0ms, deterministic so it can run during render. */
export function decryptStart(text: string): string {
  return Array.from(text)
    .map((char, i) =>
      isSpace(char) ? char : glyphs[((char.codePointAt(0) ?? 0) + i * 7) % glyphs.length],
    )
    .join("");
}

/** The frame clock; `requestAnimationFrame` in the browser, a fake in tests. */
export interface DecryptClock {
  now: () => number;
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
}

const browserClock: DecryptClock = {
  now: () => performance.now(),
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Plays one decrypt: each frame passes `decryptFrame(getText(), elapsed)` to
 * `onFrame`, so a text change mid-run settles to the new text. Once
 * `DECRYPT_MS` has passed it calls `onDone` and stops (a background tab's
 * paused frames settle on the next one). Returns a cancel that stops it
 * without calling `onDone`.
 */
export function runDecrypt({
  getText,
  onFrame,
  onDone,
  clock = browserClock,
  random = Math.random,
}: {
  getText: () => string;
  onFrame: (frame: string) => void;
  onDone: () => void;
  clock?: DecryptClock;
  random?: () => number;
}): () => void {
  const start = clock.now();
  let id: number | null = null;
  const tick = () => {
    const elapsed = clock.now() - start;
    if (elapsed >= DECRYPT_MS) {
      id = null;
      onDone();
      return;
    }
    onFrame(decryptFrame(getText(), elapsed, random));
    id = clock.request(tick);
  };
  id = clock.request(tick);
  return () => {
    if (id !== null) clock.cancel(id);
    id = null;
  };
}
