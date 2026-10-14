import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, sumUsage, usageTitle } from "./usage";

const row = (tokens: number, costUsd: number | null) => ({
  inputTokens: tokens,
  outputTokens: 1,
  cacheReadTokens: 2,
  cacheWriteTokens: 3,
  costUsd,
});

describe("sumUsage", () => {
  it("adds every token count and the reported costs", () => {
    expect(sumUsage([row(10, 0.1), row(20, 0.2)])).toEqual({
      inputTokens: 30,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 6,
      tokens: 42,
      costUsd: expect.closeTo(0.3),
      costPartial: false,
    });
  });

  it("marks the cost partial when only some steps reported one", () => {
    expect(sumUsage([row(1, 0.1), row(1, null)])).toMatchObject({
      costUsd: 0.1,
      costPartial: true,
    });
    expect(sumUsage([row(1, null)])).toMatchObject({ costUsd: null, costPartial: false });
    expect(sumUsage([])).toMatchObject({ tokens: 0, costUsd: null });
  });
});

describe("formatTokens", () => {
  it("shortens large counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(1_234_567)).toBe("1.2M");
  });
});

describe("formatCost", () => {
  it("formats a cost, a tiny one, a partial one and none", () => {
    expect(formatCost({ costUsd: 0.4213, costPartial: false })).toBe("$0.42");
    expect(formatCost({ costUsd: 0.004, costPartial: false })).toBe("<$0.01");
    expect(formatCost({ costUsd: 0, costPartial: false })).toBe("$0.00");
    expect(formatCost({ costUsd: 0.42, costPartial: true })).toBe("≥ $0.42");
    expect(formatCost({ costUsd: null, costPartial: false })).toBe("n/a");
  });
});

describe("usageTitle", () => {
  it("breaks the tokens down and explains a partial cost", () => {
    const title = usageTitle(sumUsage([row(1200, 0.1), row(0, null)]));
    expect(title).toContain("Input: 1,200");
    expect(title).toContain("Cache write: 6");
    expect(title).toContain("Some steps ran on a CLI that doesn't report cost");
  });
});
