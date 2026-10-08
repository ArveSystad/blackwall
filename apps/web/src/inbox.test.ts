import { describe, expect, it } from "vitest";
import {
  UI_STAGES,
  groupTasks,
  matchesFilter,
  needsYouCount,
  originKey,
  relativeTime,
  uiStageIndex,
} from "./inbox";
import { makeTask } from "./test-fixtures";

describe("groupTasks", () => {
  it("puts needs-you first, then running and queued, then the rest, newest first", () => {
    const old = makeTask({ status: "needs-you", updatedAt: new Date("2026-10-08T09:00:00Z") });
    const fresh = makeTask({ status: "needs-you", updatedAt: new Date("2026-10-08T11:00:00Z") });
    const running = makeTask({ status: "running" });
    const queued = makeTask({ status: "queued" });
    const failed = makeTask({ status: "failed" });
    const done = makeTask({ status: "done" });

    const groups = groupTasks([done, old, running, failed, fresh, queued]);
    expect(groups.needsYou).toEqual([fresh, old]);
    expect(groups.running).toEqual(expect.arrayContaining([running, queued]));
    expect(groups.recent).toEqual(expect.arrayContaining([failed, done]));
    expect(needsYouCount([done, old, fresh])).toBe(2);
  });
});

describe("uiStageIndex", () => {
  it("maps pipeline stages onto the six UI stages", () => {
    expect(uiStageIndex({ stage: null, status: "queued" })).toBe(-1);
    expect(uiStageIndex({ stage: "inform", status: "running" })).toBe(0);
    expect(uiStageIndex({ stage: "aggregate", status: "running" })).toBe(4);
    expect(uiStageIndex({ stage: "summarize", status: "needs-you" })).toBe(5);
    expect(uiStageIndex({ stage: "summarize", status: "done" })).toBe(UI_STAGES.length);
  });
});

describe("originKey and matchesFilter", () => {
  it("labels each origin and filters on title or key", () => {
    const jira = makeTask({
      title: "Fix login",
      origin: { kind: "jira-issue", key: "ABC-482", connectionId: null },
    });
    const pr = makeTask({
      mode: "review",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/web/pull/911",
        owner: "acme",
        repo: "web",
        number: 911,
        connectionId: null,
      },
    });
    expect(originKey(jira)).toBe("ABC-482");
    expect(originKey(pr)).toBe("acme/web#911");
    expect(originKey(makeTask())).toBe("free text");

    expect(matchesFilter(jira, " abc-4 ")).toBe(true);
    expect(matchesFilter(jira, "LOGIN")).toBe(true);
    expect(matchesFilter(pr, "login")).toBe(false);
    expect(matchesFilter(pr, "")).toBe(true);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(now.getTime() - ms), now);

  it("compacts elapsed time", () => {
    expect(ago(30_000)).toBe("now");
    expect(ago(5 * 60_000)).toBe("5m");
    expect(ago(3 * 3_600_000)).toBe("3h");
    expect(ago(30 * 3_600_000)).toBe("yday");
    expect(ago(4 * 86_400_000)).toBe("4d");
  });
});
