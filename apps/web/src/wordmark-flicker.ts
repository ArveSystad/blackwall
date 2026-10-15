/** Shortest gap between two wordmark flickers. */
export const WORDMARK_FLICKER_MIN_MS = 30_000;

/** Longest gap between two wordmark flickers. */
export const WORDMARK_FLICKER_MAX_MS = 100_000;

/** How long one wordmark flicker plays; mirrors `.bw-wordmark-flicker` in styles.css. */
export const WORDMARK_FLICKER_MS = 700;

/** A fresh random gap before the next wordmark flicker, between the min and max. */
export function flickerDelayMs(random: () => number = Math.random): number {
  return WORDMARK_FLICKER_MIN_MS + random() * (WORDMARK_FLICKER_MAX_MS - WORDMARK_FLICKER_MIN_MS);
}
