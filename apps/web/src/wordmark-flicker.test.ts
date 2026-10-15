import { describe, expect, it } from "vitest";
import {
  WORDMARK_FLICKER_MAX_MS,
  WORDMARK_FLICKER_MIN_MS,
  flickerDelayMs,
} from "./wordmark-flicker";

describe("flickerDelayMs", () => {
  it("waits the minimum gap at the bottom of the range", () => {
    expect(flickerDelayMs(() => 0)).toBe(WORDMARK_FLICKER_MIN_MS);
    expect(flickerDelayMs(() => 0)).toBe(30_000);
  });

  it("stays under the maximum gap at the top of the range", () => {
    expect(flickerDelayMs(() => 0.9999999)).toBeLessThan(WORDMARK_FLICKER_MAX_MS);
    expect(flickerDelayMs(() => 0.9999999)).toBeLessThan(100_000);
  });

  it("scales linearly between the two", () => {
    expect(flickerDelayMs(() => 0.5)).toBe(65_000);
  });
});
