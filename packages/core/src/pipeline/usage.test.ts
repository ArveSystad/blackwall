import { describe, expect, it } from "vitest";
import { addUsage, combine, emptyStepUsage, reconcile } from "./usage.js";

const call = (outputTokens: number, costUsd?: number) => ({
  inputTokens: 1,
  outputTokens,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

describe("addUsage", () => {
  it("adds tokens and leaves the cost null without one", () => {
    expect(addUsage(addUsage(emptyStepUsage(), call(3)), call(4))).toEqual({
      inputTokens: 2,
      outputTokens: 7,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: null,
    });
  });

  it("adds the cost when a call reports one", () => {
    expect(addUsage(addUsage(emptyStepUsage(), call(3, 0.01)), call(4, 0.02)).costUsd).toBeCloseTo(
      0.03,
    );
  });
});

describe("reconcile", () => {
  it("takes the larger of the events and the result per field (Claude)", () => {
    const streamed = addUsage(addUsage(emptyStepUsage(), call(3)), call(3));
    const result = { inputTokens: 1, outputTokens: 500, cacheReadTokens: 30, cacheWriteTokens: 5 };
    expect(reconcile(streamed, { ...result, costUsd: 0.05 }, false)).toEqual({
      inputTokens: 2,
      outputTokens: 500,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      costUsd: 0.05,
    });
  });

  it("keeps the events' cost when they carried one (OpenCode)", () => {
    const streamed = addUsage(addUsage(emptyStepUsage(), call(3, 0.01)), call(4, 0.02));
    const result = { ...call(7), inputTokens: 2, cacheReadTokens: 20, cacheWriteTokens: 10 };
    expect(reconcile(streamed, { ...result, costUsd: 0.03 }, true)).toEqual(streamed);
  });

  it("keeps a null cost when neither reported one", () => {
    expect(reconcile(emptyStepUsage(), call(0), false).costUsd).toBeNull();
  });
});

describe("combine", () => {
  it("adds tokens and treats a null cost as none", () => {
    const a = { ...emptyStepUsage(), outputTokens: 2, costUsd: 0.5 };
    const b = { ...emptyStepUsage(), outputTokens: 3 };
    expect(combine(a, b)).toEqual({ ...emptyStepUsage(), outputTokens: 5, costUsd: 0.5 });
    expect(combine(b, b).costUsd).toBeNull();
  });
});
