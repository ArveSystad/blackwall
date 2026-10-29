import { describe, expect, it } from "vitest";
import {
  advanceReveal,
  commonPrefixLength,
  revealFrame,
  runReveal,
  STREAM_CATCHUP_MS,
  STREAM_CHARS_PER_MS,
  STREAM_GLYPHS,
  STREAM_TAIL_CHARS,
  STREAM_TICK_MS,
} from "./chat-stream";
import type { DecryptClock } from "./decrypt";

const glyphs = Array.from(STREAM_GLYPHS);

/** A deterministic `random` that walks through [0, 1). */
function seq() {
  let i = 0;
  return () => (i++ % 17) / 17;
}

function fakeClock() {
  let next = 1;
  const queue = new Map<number, () => void>();
  const state = { t: 0 };
  const clock: DecryptClock = {
    now: () => state.t,
    request: (callback) => {
      const id = next++;
      queue.set(id, callback);
      return id;
    },
    cancel: (id) => {
      queue.delete(id);
    },
  };
  /** Runs the queued frames at time `t`. */
  const frameAt = (t: number) => {
    state.t = t;
    const callbacks = [...queue.values()];
    queue.clear();
    for (const callback of callbacks) callback();
  };
  return { clock, queue, frameAt };
}

describe("revealFrame", () => {
  const text = "The quick brown fox jumps over the lazy dog";

  it("is empty at the start and exactly the text once all is shown", () => {
    expect(revealFrame(text, 0, seq())).toBe("");
    expect(revealFrame(text, text.length, seq())).toBe(text);
    expect(revealFrame(text, text.length + 5, seq())).toBe(text);
  });

  it("ends the visible text on a word boundary", () => {
    for (let shown = 1; shown < text.length; shown++) {
      const frame = revealFrame(text, shown, seq());
      const next = text[frame.length];
      expect(next === undefined || next === " ").toBe(true);
      expect(frame.length).toBeGreaterThanOrEqual(shown);
    }
  });

  it("scrambles only the letters and digits of the tail, with its own glyphs", () => {
    const markdown = "Use **bold** and `code` here, then rest of the answer";
    const frame = revealFrame(markdown, 30, seq());
    const visible = markdown.slice(0, frame.length);
    Array.from(visible).forEach((char, i) => {
      const shown = frame[i] ?? "";
      if (!/[\p{L}\p{N}]/u.test(char) || i < visible.length - STREAM_TAIL_CHARS) {
        expect(shown).toBe(char);
      } else {
        expect(glyphs).toContain(shown);
      }
    });
    expect(frame).toContain("**bold**");
    expect(frame.match(/`/g)).toHaveLength(2);
  });
});

describe("advanceReveal", () => {
  it("reveals at least the base rate", () => {
    expect(advanceReveal(0, 100, 10).shown).toBeCloseTo(10 * STREAM_CHARS_PER_MS);
  });

  it("clears a large backlog within the catch-up time", () => {
    let state = { shown: 0, pace: 0 };
    let t = 0;
    while (state.shown < 10_000 && t < 10_000) {
      t += 16;
      state = advanceReveal(state.shown, 10_000, 16, state.pace);
    }
    expect(t).toBeLessThanOrEqual(STREAM_CATCHUP_MS + STREAM_TICK_MS);
    expect(state.pace).toBe(0);
  });
});

describe("commonPrefixLength", () => {
  it("skips all of an identical reply, or one the draft ran past", () => {
    expect(commonPrefixLength("Hello world", "Hello world")).toBe(11);
    expect(commonPrefixLength("Hello world and more", "Hello world")).toBe(11);
  });

  it("snaps back to a word start where the texts diverge", () => {
    expect(commonPrefixLength("Hello wor", "Hello world")).toBe(6);
    // A draft cut at a code fence.
    expect(commonPrefixLength("Try this:", "Try this:\n\n```ts\nx\n```")).toBe(4);
    expect(commonPrefixLength("Try this: ", "Try this:\n\n```ts\nx\n```")).toBe(4);
    expect(commonPrefixLength("Something else", "Hello")).toBe(0);
  });
});

describe("runReveal", () => {
  it("follows a growing target, throttles frames and calls onCaughtUp once", () => {
    const { clock, queue, frameAt } = fakeClock();
    let target = "one two";
    const frames: string[] = [];
    const caught: number[] = [];
    runReveal({
      getTarget: () => target,
      from: 0,
      onFrame: (f) => frames.push(f),
      onCaughtUp: (length) => caught.push(length),
      clock,
      random: seq(),
    });
    frameAt(5);
    frameAt(10);
    // Throttled: the frame at 10ms is within STREAM_TICK_MS of the one at 5ms.
    expect(frames).toHaveLength(1);
    target = "one two three four five six seven ".repeat(6).trim();
    for (let t = 20; t < 2000 && queue.size > 0; t += 16) frameAt(t);
    expect(caught).toEqual([target.length]);
    expect(frames.length).toBeGreaterThan(2);
    expect(queue.size).toBe(0);
  });

  it("stops after cancel", () => {
    const { clock, queue, frameAt } = fakeClock();
    const frames: string[] = [];
    const caught: number[] = [];
    const cancel = runReveal({
      getTarget: () => "a long reply that keeps going",
      from: 0,
      onFrame: (f) => frames.push(f),
      onCaughtUp: (length) => caught.push(length),
      clock,
    });
    frameAt(5);
    cancel();
    expect(queue.size).toBe(0);
    frameAt(500);
    expect(frames).toHaveLength(1);
    expect(caught).toEqual([]);
  });

  it("catches up at once when nothing is left past `from`", () => {
    const { clock, frameAt } = fakeClock();
    const caught: number[] = [];
    runReveal({
      getTarget: () => "done",
      from: 4,
      onFrame: () => undefined,
      onCaughtUp: (length) => caught.push(length),
      clock,
    });
    frameAt(1);
    expect(caught).toEqual([4]);
  });
});
