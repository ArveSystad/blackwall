import type { StepStatus } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { activeTimeMs, stepDurationMs, wallClockMs } from "./timing";

const at = (seconds: number) => new Date(seconds * 1000);

const step = (start: number | null, finish: number | null, status: StepStatus = "succeeded") => ({
  status,
  startedAt: start === null ? null : at(start),
  finishedAt: finish === null ? null : at(finish),
});

describe("stepDurationMs", () => {
  it("is null for a step that has not started", () => {
    expect(stepDurationMs(step(null, null, "pending"), at(100))).toBeNull();
  });

  it("runs up to now while the step runs", () => {
    expect(stepDurationMs(step(10, null, "running"), at(25))).toBe(15_000);
  });

  it("is the start to the finish of a finished step", () => {
    expect(stepDurationMs(step(10, 70), at(500))).toBe(60_000);
  });

  it("is null when a stopped step has no finish time", () => {
    expect(stepDurationMs(step(10, null, "interrupted"), at(500))).toBeNull();
  });

  it("is never negative", () => {
    expect(stepDurationMs(step(10, null, "running"), at(5))).toBe(0);
    expect(stepDurationMs(step(10, 5), at(500))).toBe(0);
  });
});

describe("activeTimeMs", () => {
  it("adds up disjoint steps and leaves out the gap waiting on the user", () => {
    // Planning, a 10-minute wait at plan approval, then implementing.
    expect(activeTimeMs([step(0, 60), step(660, 720)])).toBe(120_000);
  });

  it("counts overlapping parallel steps once", () => {
    expect(activeTimeMs([step(0, 60), step(30, 90)])).toBe(90_000);
  });

  it("merges nested intervals", () => {
    expect(activeTimeMs([step(0, 100), step(10, 20)])).toBe(100_000);
  });

  it("does not depend on the order of the steps", () => {
    expect(activeTimeMs([step(200, 260), step(30, 90), step(0, 60)])).toBe(150_000);
  });

  it("ignores steps without a start or finish", () => {
    expect(
      activeTimeMs([step(0, 60), step(null, null, "pending"), step(100, null, "interrupted")]),
    ).toBe(60_000);
  });

  it("is 0 without steps", () => {
    expect(activeTimeMs([])).toBe(0);
  });
});

describe("wallClockMs", () => {
  it("spans the earliest start to the latest finish, waits included", () => {
    expect(wallClockMs([step(660, 720), step(0, 60)])).toBe(720_000);
  });

  it("is null when no step has both times", () => {
    expect(wallClockMs([])).toBeNull();
    expect(wallClockMs([step(10, null, "running"), step(null, null, "pending")])).toBeNull();
  });
});
