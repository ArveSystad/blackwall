import type { QuotaState } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { QUOTA_BACKOFF_MAX_MS, QUOTA_BACKOFF_MS, createQuotaTracker } from "./quota.js";

let opened: OpenedDatabase;
let r: Repositories;
let now: Date;
let changes: QuotaState[][];

const clock = () => now;
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const tracker = () =>
  createQuotaTracker({ settings: r.settings, clock, onChange: (state) => changes.push(state) });

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  now = new Date("2026-10-09T12:00:00Z");
  changes = [];
});

afterEach(() => opened.close());

describe("quota tracker", () => {
  it("pauses a CLI until its reset time and persists it across restarts", () => {
    const resetsAt = new Date("2026-10-09T15:00:00Z");
    expect(tracker().report("claude", { resetsAt, taskId: "t1" })).toEqual(resetsAt);
    const reopened = tracker();
    expect(reopened.isPaused("claude")).toBe(true);
    expect(reopened.isPaused("copilot")).toBe(false);
    expect(reopened.state()).toEqual([
      { cli: "claude", pausedUntil: resetsAt },
      { cli: "copilot", pausedUntil: null },
      { cli: "opencode", pausedUntil: null },
    ]);
    expect(changes).toHaveLength(1);
    expect(reopened.nextReset()).toEqual(resetsAt);

    advance(3 * 3_600_000);
    expect(reopened.isPaused("claude")).toBe(false);
  });

  it("backs off 15 min, doubling, capped at 5 h, when no reset time is given", () => {
    const quota = tracker();
    const pauses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = now.getTime();
      pauses.push(quota.report("copilot").getTime() - start);
      advance(pauses.at(-1)! + 1);
    }
    expect(pauses).toEqual([
      QUOTA_BACKOFF_MS,
      QUOTA_BACKOFF_MS * 2,
      QUOTA_BACKOFF_MS * 4,
      QUOTA_BACKOFF_MS * 8,
      QUOTA_BACKOFF_MS * 16,
      QUOTA_BACKOFF_MAX_MS,
      QUOTA_BACKOFF_MAX_MS,
    ]);
  });

  it("keeps a running pause for hits in the same window and starts over after a success", () => {
    const quota = tracker();
    const first = quota.report("copilot");
    advance(60_000);
    expect(quota.report("copilot")).toEqual(first);
    advance(QUOTA_BACKOFF_MS);
    quota.succeeded("copilot");
    const start = now.getTime();
    expect(quota.report("copilot").getTime() - start).toBe(QUOTA_BACKOFF_MS);
  });

  it("releases the waiting tasks once their pause has ended", () => {
    const quota = tracker();
    quota.report("claude", { resetsAt: new Date(now.getTime() + 60_000), taskId: "t1" });
    quota.report("copilot", { resetsAt: new Date(now.getTime() + 120_000), taskId: "t2" });
    quota.report("claude", { taskId: "t3" });
    expect(quota.release()).toEqual([]);

    advance(61_000);
    expect(quota.release()).toEqual(["t1", "t3"]);
    expect(quota.release()).toEqual([]);
    expect(quota.isPaused("claude")).toBe(false);
    expect(changes.at(-1)).toEqual([
      { cli: "claude", pausedUntil: null },
      { cli: "copilot", pausedUntil: new Date("2026-10-09T12:02:00Z") },
      { cli: "opencode", pausedUntil: null },
    ]);

    advance(60_000);
    expect(quota.release()).toEqual(["t2"]);
    expect(quota.nextReset()).toBeNull();
  });

  it("holds a task back while another CLI it waits on is still paused", () => {
    const quota = tracker();
    quota.report("claude", { resetsAt: new Date(now.getTime() + 60_000), taskId: "t1" });
    quota.report("copilot", { resetsAt: new Date(now.getTime() + 120_000), taskId: "t1" });
    advance(61_000);
    expect(quota.release()).toEqual([]);
    advance(60_000);
    expect(quota.release()).toEqual(["t1"]);
  });
});
