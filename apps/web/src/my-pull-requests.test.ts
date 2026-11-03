import type { MyPullRequestDetail } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checksLabel,
  hasUnseenActivity,
  mergeWarnings,
  myPrPillLabel,
  pruneSeen,
  pullRequestName,
  reviewDecisionLabel,
  type SeenMap,
} from "./my-pull-requests";

const URL_A = "https://github.com/acme/shop/pull/1";
const URL_B = "https://github.com/acme/shop/pull/2";

const pr = (patch: Partial<Parameters<typeof hasUnseenActivity>[0]> = {}) => ({
  url: URL_A,
  activityAt: "2026-10-02T10:00:00Z" as string | null,
  checks: "pending" as "pending" | "passed" | "failed" | null,
  ...patch,
});

describe("hasUnseenActivity", () => {
  it("counts a PR never opened only when someone else has been active on it", () => {
    expect(hasUnseenActivity(pr(), {})).toBe(true);
    expect(hasUnseenActivity(pr({ activityAt: null, checks: "failed" }), {})).toBe(false);
  });

  it("counts newer activity since the PR was last opened", () => {
    const seen: SeenMap = { [URL_A]: { activityAt: "2026-10-01T10:00:00Z", checks: "pending" } };
    expect(hasUnseenActivity(pr(), seen)).toBe(true);
    const none: SeenMap = { [URL_A]: { activityAt: null, checks: "pending" } };
    expect(hasUnseenActivity(pr(), none)).toBe(true);
  });

  it("counts checks that settled since the PR was last opened", () => {
    const seen: SeenMap = { [URL_A]: { activityAt: "2026-10-02T10:00:00Z", checks: "pending" } };
    expect(hasUnseenActivity(pr({ checks: "passed" }), seen)).toBe(true);
    expect(hasUnseenActivity(pr({ checks: "failed" }), seen)).toBe(true);
    const settled: SeenMap = { [URL_A]: { activityAt: "2026-10-02T10:00:00Z", checks: "passed" } };
    expect(hasUnseenActivity(pr({ checks: "pending" }), settled)).toBe(false);
  });

  it("is quiet when nothing changed", () => {
    const seen: SeenMap = { [URL_A]: { activityAt: "2026-10-02T10:00:00Z", checks: "passed" } };
    expect(hasUnseenActivity(pr({ checks: "passed" }), seen)).toBe(false);
    const older: SeenMap = { [URL_A]: { activityAt: "2026-10-03T10:00:00Z", checks: null } };
    expect(hasUnseenActivity(pr({ checks: null }), older)).toBe(false);
  });
});

describe("pruneSeen", () => {
  it("keeps only the PRs still listed", () => {
    const seen: SeenMap = {
      [URL_A]: { activityAt: null, checks: null },
      [URL_B]: { activityAt: null, checks: "passed" },
    };
    expect(pruneSeen(seen, [URL_B])).toEqual({ [URL_B]: { activityAt: null, checks: "passed" } });
    expect(pruneSeen(seen, [])).toEqual({});
  });
});

describe("seen store", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
  }

  async function load() {
    // Fresh module per test so the in-memory map starts unread.
    vi.resetModules();
    return import("./my-pull-requests");
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("remembers what was seen, and forgets PRs no longer listed", async () => {
    const store = await load();
    store.markSeen({ url: URL_A, activityAt: "2026-10-02T10:00:00Z", checks: "passed" });
    store.markSeen({ url: URL_B, activityAt: null, checks: null });
    expect(store.loadSeen()).toEqual({
      [URL_A]: { activityAt: "2026-10-02T10:00:00Z", checks: "passed" },
      [URL_B]: { activityAt: null, checks: null },
    });
    store.forgetUnlisted([URL_B]);
    expect(Object.keys(store.loadSeen())).toEqual([URL_B]);
  });

  it("reads malformed storage as nothing seen", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        "bw:my-prs-seen": JSON.stringify({
          [URL_A]: { activityAt: 3, checks: "passed" },
          [URL_B]: { activityAt: null, checks: "passed" },
        }),
      }),
    );
    const store = await load();
    expect(store.loadSeen()).toEqual({ [URL_B]: { activityAt: null, checks: "passed" } });
    vi.stubGlobal("localStorage", memoryStorage({ "bw:my-prs-seen": "not json" }));
    expect(store.loadSeen()).toEqual({});
  });
});

describe("labels", () => {
  it("names the pill's count", () => {
    expect(myPrPillLabel(0)).toBe("No pull requests of yours are open");
    expect(myPrPillLabel(1)).toBe("1 pull request of yours is open");
    expect(myPrPillLabel(3)).toBe("3 pull requests of yours are open");
  });

  it("names review decisions, checks and PRs", () => {
    expect(reviewDecisionLabel("approved")).toBe("Approved");
    expect(reviewDecisionLabel(null)).toBe("No review required");
    expect(checksLabel("pending")).toBe("Checks running");
    expect(checksLabel(null)).toBe("No checks");
    expect(pullRequestName("https://acme.ghe.com/acme/shop/pull/42")).toBe("acme/shop#42");
    expect(pullRequestName("not a link")).toBe("not a link");
  });
});

describe("mergeWarnings", () => {
  const detail = (
    patch: Partial<MyPullRequestDetail> = {},
  ): Parameters<typeof mergeWarnings>[0] => ({
    reviewDecision: "approved",
    checks: [],
    draft: false,
    mergeable: true,
    base: "main",
    ...patch,
  });
  const check = (state: "pending" | "passed" | "failed") => ({
    name: state,
    kind: "check-run" as const,
    id: 1,
    state,
    conclusion: null,
    url: null,
  });

  it("is empty for an approved, green, clean PR", () => {
    expect(mergeWarnings(detail({ checks: [check("passed")] }))).toEqual([]);
    expect(mergeWarnings(detail({ reviewDecision: null }))).toEqual([]);
  });

  it("warns about missing approval, checks, drafts and conflicts", () => {
    expect(
      mergeWarnings(
        detail({
          reviewDecision: "changes-requested",
          checks: [check("pending"), check("failed")],
          draft: true,
          mergeable: false,
        }),
      ),
    ).toEqual([
      "A reviewer asked for changes.",
      "Checks are failing.",
      "It is a draft.",
      "It has conflicts with main.",
    ]);
    expect(
      mergeWarnings(detail({ reviewDecision: "review-required", checks: [check("pending")] })),
    ).toEqual(["It isn't approved yet.", "Checks are still running."]);
  });
});
