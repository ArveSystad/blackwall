import type { TaskCi } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  UI_STAGES,
  activeAgentsLabel,
  doneTasks,
  groupTasks,
  matchesFilter,
  needsYouCount,
  newTaskIds,
  nextArrivals,
  nextSweeps,
  originKey,
  relativeTime,
  stackLabel,
  statusChanges,
  statusLabel,
  uiStageIndex,
} from "./inbox";
import { makeTask } from "./test-fixtures";

/** A valid CI watch on a pushed commit; the checks default to one passing check run. */
function taskCi(overrides: Partial<TaskCi> = {}): TaskCi {
  return {
    state: "passed",
    sha: "abc1234def5678",
    host: "github.com",
    owner: "acme",
    repo: "web",
    checks: [
      {
        name: "unit",
        kind: "check-run",
        id: 7,
        state: "passed",
        conclusion: "success",
        url: "https://github.com/acme/web/runs/7",
      },
    ],
    hint: null,
    startedAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:05:00.000Z",
    finishedAt: "2026-10-08T10:05:00.000Z",
    ...overrides,
  };
}

const failedCi = taskCi({
  state: "failed",
  checks: [
    {
      name: "unit",
      kind: "check-run",
      id: 7,
      state: "failed",
      conclusion: "failure",
      url: "https://github.com/acme/web/runs/7",
    },
  ],
});

describe("groupTasks", () => {
  it("puts a done task with failed CI in needs-you, not in recent", () => {
    const ciFailed = makeTask({ status: "done", ci: failedCi });
    const groups = groupTasks([ciFailed]);
    expect(groups.needsYou).toEqual([ciFailed]);
    expect(groups.recent).toEqual([]);
    expect(needsYouCount([ciFailed])).toBe(1);
  });

  it("keeps archived and passing-CI done tasks out of needs-you", () => {
    const archived = makeTask({
      status: "done",
      ci: failedCi,
      archivedAt: new Date("2026-10-08T12:00:00Z"),
    });
    const passed = makeTask({ status: "done", ci: taskCi({ state: "passed" }) });
    const groups = groupTasks([archived, passed]);
    expect(groups.needsYou).toEqual([]);
    expect(groups.recent).toEqual([passed]);
    expect(needsYouCount([archived, passed])).toBe(0);
  });

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

  it("leaves archived tasks out", () => {
    const listed = makeTask({ status: "done" });
    const archived = makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00Z") });
    expect(groupTasks([listed, archived]).recent).toEqual([listed]);
  });
});

describe("doneTasks", () => {
  it("keeps unarchived done tasks and drops archived ones and every other status", () => {
    const done = makeTask({ status: "done" });
    const archived = makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00Z") });
    const others = (["needs-you", "running", "queued", "interrupted", "failed"] as const).map(
      (status) => makeTask({ status }),
    );
    expect(doneTasks([done, archived, ...others])).toEqual([done]);
  });
});

describe("statusLabel", () => {
  it("reads Finishing while a needs-you task delivers", () => {
    expect(statusLabel({ status: "needs-you", delivering: true })).toBe("Finishing");
    expect(statusLabel({ status: "needs-you", delivering: false })).toBe("Needs you");
    expect(statusLabel({ status: "running", delivering: false })).toBe("Running");
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
    expect(originKey(makeTask())).toBe("blackwall");
    const issue = makeTask({
      origin: {
        kind: "github-issue",
        url: "https://github.com/acme/web/issues/7",
        owner: "acme",
        repo: "web",
        number: 7,
        connectionId: null,
      },
    });
    expect(originKey(issue)).toBe("acme/web#7");

    expect(matchesFilter(jira, " abc-4 ")).toBe(true);
    expect(matchesFilter(jira, "LOGIN")).toBe(true);
    expect(matchesFilter(pr, "login")).toBe(false);
    expect(matchesFilter(pr, "")).toBe(true);
  });

  it("matches archived tasks too, as the archive search reuses it", () => {
    const archived = makeTask({
      title: "Fix login",
      origin: { kind: "jira-issue", key: "ABC-482", connectionId: null },
      archivedAt: new Date("2026-10-08T12:00:00Z"),
    });
    expect(matchesFilter(archived, "Login")).toBe(true);
    expect(matchesFilter(archived, "abc-482")).toBe(true);
    expect(matchesFilter(archived, "signup")).toBe(false);
  });
});

describe("activeAgentsLabel", () => {
  it("counts agents, and is null when none run", () => {
    expect(activeAgentsLabel(0)).toBeNull();
    expect(activeAgentsLabel(1)).toBe("1 active agent");
    expect(activeAgentsLabel(3)).toBe("3 active agents");
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

describe("stackLabel", () => {
  const pr = {
    kind: "github-pr",
    url: "https://github.com/acme/web/pull/42",
    owner: "acme",
    repo: "web",
    number: 42,
    connectionId: null,
  } as const;

  it("names the stack by its bottom PR and gives this PR's place", () => {
    expect(stackLabel({ ...pr, stack: { prs: [41, 42, 43] } })).toEqual({
      text: "stack #41 · 2/3",
      title: "Stacked PRs: #41 → #42 → #43",
    });
  });

  it("is undefined for unstacked PRs and other origins", () => {
    expect(stackLabel(pr)).toBeUndefined();
    expect(stackLabel({ kind: "free-text" })).toBeUndefined();
  });
});

describe("statusChanges", () => {
  it("gives the tasks whose status changed, in tasks order", () => {
    const a = makeTask({ status: "needs-you" });
    const b = makeTask({ status: "done" });
    const c = makeTask({ status: "failed" });
    const prev = new Map([
      [a.id, "running"],
      [b.id, "running"],
      [c.id, "needs-you"],
    ] as const);
    expect(statusChanges(prev, [c, a, b])).toEqual([c.id, a.id, b.id]);
  });

  it("skips first sightings and unchanged statuses", () => {
    const seen = makeTask({ status: "running" });
    const fresh = makeTask({ status: "done" });
    expect(statusChanges(new Map([[seen.id, "running"]]), [seen, fresh])).toEqual([]);
  });

  it("skips turns to queued and archived tasks", () => {
    const queued = makeTask({ status: "queued" });
    const archived = makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00Z") });
    const prev = new Map([
      [queued.id, "running"],
      [archived.id, "running"],
    ] as const);
    expect(statusChanges(prev, [queued, archived])).toEqual([]);
  });
});

describe("nextSweeps", () => {
  it("bumps a changed shown id from absent to 1, then to 2", () => {
    const shown = new Set(["a"]);
    const once = nextSweeps(new Map(), ["a"], shown);
    expect(once).toEqual(new Map([["a", 1]]));
    expect(nextSweeps(once, ["a"], shown)).toEqual(new Map([["a", 2]]));
  });

  it("does not add a changed id that is not shown", () => {
    expect(nextSweeps(new Map(), ["a"], new Set(["b"]))).toEqual(new Map());
  });

  it("drops entries no longer shown and keeps unchanged shown counters", () => {
    const sweeps = new Map([
      ["a", 3],
      ["b", 1],
    ]);
    expect(nextSweeps(sweeps, [], new Set(["a"]))).toEqual(new Map([["a", 3]]));
  });
});

describe("newTaskIds", () => {
  it("returns unseen ids in tasks order", () => {
    const b = makeTask({ id: "b" });
    const a = makeTask({ id: "a" });
    expect(newTaskIds(new Set(), [b, a])).toEqual(["b", "a"]);
  });

  it("skips seen ids", () => {
    const tasks = [makeTask({ id: "a" }), makeTask({ id: "b" })];
    expect(newTaskIds(new Set(["a"]), tasks)).toEqual(["b"]);
  });

  it("skips archived new tasks", () => {
    const archived = makeTask({ id: "a", archivedAt: new Date("2026-10-08T12:00:00Z") });
    expect(newTaskIds(new Set(), [archived])).toEqual([]);
  });
});

describe("nextArrivals", () => {
  it("adds a new shown id", () => {
    expect(nextArrivals(new Set(), ["a"], new Set(["a"]))).toEqual(new Set(["a"]));
  });

  it("does not add a new id that is not shown", () => {
    expect(nextArrivals(new Set(), ["a"], new Set(["b"]))).toEqual(new Set());
  });

  it("drops arrivals no longer shown and keeps shown ones", () => {
    expect(nextArrivals(new Set(["a", "b"]), [], new Set(["a"]))).toEqual(new Set(["a"]));
  });
});
