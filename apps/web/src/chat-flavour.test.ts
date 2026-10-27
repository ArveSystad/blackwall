import { describe, expect, it } from "vitest";
import {
  CHAT_FLAVOUR_MAX_MS,
  CHAT_FLAVOUR_MIN_MS,
  CHAT_FLAVOUR_PHRASES,
  flavourDelayMs,
  nextPhrase,
} from "./chat-flavour";

const n = CHAT_FLAVOUR_PHRASES.length;

describe("nextPhrase", () => {
  it("never repeats the previous phrase", () => {
    for (const previous of CHAT_FLAVOUR_PHRASES) {
      for (const value of [0, 0.5, 0.9999999]) {
        const next = nextPhrase(previous, () => value);
        expect(next).not.toBe(previous);
        expect(CHAT_FLAVOUR_PHRASES).toContain(next);
      }
    }
  });

  it("picks from the whole list without a known previous phrase", () => {
    for (const previous of [null, "Not a phrase…"]) {
      expect(CHAT_FLAVOUR_PHRASES).toContain(nextPhrase(previous, () => 0.5));
      expect(nextPhrase(previous, () => 0)).toBe(CHAT_FLAVOUR_PHRASES[0]);
      expect(nextPhrase(previous, () => 0.9999999)).toBe(CHAT_FLAVOUR_PHRASES[n - 1]);
    }
  });

  it("can reach every other phrase", () => {
    const first = CHAT_FLAVOUR_PHRASES[0]!;
    const reached = new Set<string>();
    for (let k = 0; k < n - 1; k++) {
      reached.add(nextPhrase(first, () => k / (n - 1)));
    }
    expect(reached).toEqual(new Set(CHAT_FLAVOUR_PHRASES.slice(1)));
  });

  it("never repeats in a row with the real random source", () => {
    let previous: string | null = null;
    for (let k = 0; k < 1_000; k++) {
      const next = nextPhrase(previous);
      expect(next).not.toBe(previous);
      expect(CHAT_FLAVOUR_PHRASES).toContain(next);
      previous = next;
    }
  });
});

describe("flavourDelayMs", () => {
  it("waits the minimum gap at the bottom of the range", () => {
    expect(flavourDelayMs(() => 0)).toBe(CHAT_FLAVOUR_MIN_MS);
    expect(flavourDelayMs(() => 0)).toBe(2_500);
  });

  it("stays under the maximum gap at the top of the range", () => {
    expect(flavourDelayMs(() => 0.9999999)).toBeLessThan(CHAT_FLAVOUR_MAX_MS);
    expect(flavourDelayMs(() => 0.9999999)).toBeLessThan(4_000);
  });

  it("scales linearly between the two", () => {
    expect(flavourDelayMs(() => 0.5)).toBe(3_250);
  });
});
