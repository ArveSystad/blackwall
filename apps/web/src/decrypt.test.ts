import { describe, expect, it } from "vitest";
import {
  DECRYPT_GLYPHS,
  DECRYPT_MS,
  decryptFrame,
  decryptStart,
  runDecrypt,
  type DecryptClock,
} from "./decrypt";

const glyphs = Array.from(DECRYPT_GLYPHS);

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

describe("decryptFrame", () => {
  it("scrambles every non-space character at 0ms and keeps the length", () => {
    const text = "fix the 😀 bug";
    const frame = decryptFrame(text, 0, seq());
    const chars = Array.from(frame);
    expect(chars).toHaveLength(Array.from(text).length);
    Array.from(text).forEach((char, i) => {
      if (char === " ") expect(chars[i]).toBe(" ");
      else expect(glyphs).toContain(chars[i]);
    });
  });

  it("settles left to right and never reverts", () => {
    const text = "blackwall";
    const n = text.length;
    let settled = -1;
    for (let t = 0; t < DECRYPT_MS; t += 5) {
      const frame = decryptFrame(text, t, () => 0.999);
      let prefix = 0;
      while (prefix < n && frame[prefix] === text[prefix]) prefix++;
      expect(prefix).toBeGreaterThanOrEqual(settled);
      settled = prefix;
    }
    for (let i = 0; i < n; i++) {
      const frame = decryptFrame(text, ((i + 1) / n) * DECRYPT_MS, () => 0.999);
      expect(frame.slice(0, i + 1)).toBe(text.slice(0, i + 1));
      // 0.999 picks ">", which is in no position of the text.
      if (i + 1 < n) expect(frame.slice(i + 1)).toBe(">".repeat(n - i - 1));
    }
  });

  it("is exactly the text from DECRYPT_MS on", () => {
    expect(decryptFrame("hello world", DECRYPT_MS, seq())).toBe("hello world");
    expect(decryptFrame("hello world", DECRYPT_MS * 5, seq())).toBe("hello world");
  });

  it("keeps an empty string empty", () => {
    expect(decryptFrame("", 0)).toBe("");
    expect(decryptStart("")).toBe("");
  });
});

describe("decryptStart", () => {
  it("is deterministic, scrambled and the same length", () => {
    const text = "Ship the 😀 thing";
    expect(decryptStart(text)).toBe(decryptStart(text));
    const chars = Array.from(decryptStart(text));
    expect(chars).toHaveLength(Array.from(text).length);
    Array.from(text).forEach((char, i) => {
      if (char === " ") expect(chars[i]).toBe(" ");
      else expect(glyphs).toContain(chars[i]);
    });
  });
});

describe("runDecrypt", () => {
  it("draws scrambled frames, then settles once and stops", () => {
    const { clock, queue, frameAt } = fakeClock();
    const frames: string[] = [];
    let done = 0;
    runDecrypt({
      getText: () => "blackwall",
      onFrame: (f) => frames.push(f),
      onDone: () => done++,
      clock,
      random: () => 0.999,
    });
    frameAt(0);
    frameAt(100);
    frameAt(200);
    expect(frames).toHaveLength(3);
    for (const f of frames) expect(f).not.toBe("blackwall");
    expect(done).toBe(0);
    frameAt(300);
    expect(frames).toHaveLength(3);
    expect(done).toBe(1);
    expect(queue.size).toBe(0);
  });

  it("stops without settling when cancelled", () => {
    const { clock, queue, frameAt } = fakeClock();
    const frames: string[] = [];
    let done = 0;
    const cancel = runDecrypt({
      getText: () => "blackwall",
      onFrame: (f) => frames.push(f),
      onDone: () => done++,
      clock,
    });
    frameAt(0);
    cancel();
    expect(queue.size).toBe(0);
    frameAt(400);
    expect(frames).toHaveLength(1);
    expect(done).toBe(0);
  });

  it("uses the latest text mid-run", () => {
    const { clock, frameAt } = fakeClock();
    const frames: string[] = [];
    let text = "abc";
    let settled: string | null = null;
    runDecrypt({
      getText: () => text,
      onFrame: (f) => frames.push(f),
      onDone: () => (settled = text),
      clock,
      random: () => 0.999,
    });
    frameAt(0);
    text = "abcdef";
    frameAt(100);
    expect(Array.from(frames[1] ?? "")).toHaveLength(6);
    expect(frames[1]).toBe(decryptFrame("abcdef", 100, () => 0.999));
    frameAt(300);
    expect(settled).toBe("abcdef");
  });
});
