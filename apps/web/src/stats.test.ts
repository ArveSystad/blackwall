import { afterEach, describe, expect, it, vi } from "vitest";
import { dayLabel, shortDayLabel, STATS_DAYS, taskStats, taskType } from "./stats";
import { makeTask } from "./test-fixtures";

const pr = {
  kind: "github-pr" as const,
  url: "https://github.com/acme/app/pull/1",
  owner: "acme",
  repo: "app",
  number: 1,
  connectionId: null,
};
const jira = { kind: "jira-issue" as const, key: "ABC-1", connectionId: null };
const issue = {
  kind: "github-issue" as const,
  url: "https://github.com/acme/app/issues/2",
  owner: "acme",
  repo: "app",
  number: 2,
  connectionId: null,
};

// Local times, so the assertions hold in any timezone.
const now = new Date(2026, 9, 9, 15, 0);

describe("taskType", () => {
  it("maps origins to types, splitting PR tasks by mode", () => {
    expect(taskType(makeTask({ origin: jira }))).toBe("jira");
    expect(taskType(makeTask({ origin: pr, mode: "work" }))).toBe("pr-work");
    expect(taskType(makeTask({ origin: pr, mode: "review" }))).toBe("pr-review");
    expect(taskType(makeTask({ origin: issue }))).toBe("issue");
    expect(taskType(makeTask())).toBe("free-text");
  });
});

describe("taskStats", () => {
  it("counts done tasks, archived ones included, per type", () => {
    const tasks = [
      makeTask({ status: "done", origin: jira }),
      makeTask({ status: "done", origin: pr, mode: "review" }),
      makeTask({ status: "done", archivedAt: new Date(2026, 9, 9) }),
      makeTask({ status: "done", origin: issue }),
      makeTask({ status: "running", origin: pr, mode: "work", repoId: "r2" }),
      makeTask({ status: "failed", repoId: "r3" }),
    ];
    const stats = taskStats(tasks, [], now);
    expect(stats.resolved).toBe(4);
    expect(stats.byType).toEqual({
      jira: 1,
      "pr-work": 0,
      "pr-review": 1,
      issue: 1,
      "free-text": 1,
    });
    expect(stats.repos).toBe(3);
  });

  it("has no per-day counts until the done times load", () => {
    expect(taskStats([makeTask({ status: "done" })], undefined, now).perDay).toBeNull();
  });

  it("buckets by local calendar day, zero-filled, oldest first", () => {
    const done = (doneAt: Date) => {
      const task = makeTask({ status: "done" });
      return { task, time: { taskId: task.id, doneAt } };
    };
    const lateYesterday = done(new Date(2026, 9, 8, 23, 59));
    const earlyToday = done(new Date(2026, 9, 9, 0, 1));
    const firstDay = done(new Date(2026, 8, 30, 0, 0));
    const tooOld = done(new Date(2026, 8, 29, 23, 59));
    const all = [lateYesterday, earlyToday, firstDay, tooOld];

    const stats = taskStats(
      all.map((d) => d.task),
      all.map((d) => d.time),
      now,
    );
    expect(stats.resolved).toBe(4);
    const perDay = stats.perDay!;
    expect(perDay).toHaveLength(STATS_DAYS);
    expect(perDay[0]!.date).toEqual(new Date(2026, 8, 30));
    expect(perDay.at(-1)!.date).toEqual(new Date(2026, 9, 9));
    expect(perDay.map((d) => d.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });

  it("falls back to updatedAt only for done tasks missing from the done times", () => {
    const listed = makeTask({ status: "done", updatedAt: new Date(2026, 9, 9, 9) });
    const old = makeTask({ status: "done", updatedAt: new Date(2026, 9, 7, 9) });
    const times = [{ taskId: listed.id, doneAt: new Date(2026, 9, 5, 9) }];

    const counts = taskStats([listed, old], times, now).perDay!.map((d) => d.count);
    expect(counts).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 0, 0]);
  });

  describe("across a DST change", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("still covers ten distinct local days", () => {
      vi.stubEnv("TZ", "Europe/Oslo");
      // Summer time starts on 29 March 2026 in Oslo.
      const march = new Date(2026, 2, 31, 12);
      const task = makeTask({ status: "done" });
      const perDay = taskStats(
        [task],
        [{ taskId: task.id, doneAt: new Date(2026, 2, 29, 0, 30) }],
        march,
      ).perDay!;

      expect(perDay.map((d) => d.date.getDate())).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
      expect(perDay.every((d) => d.date.getHours() === 0)).toBe(true);
      expect(perDay.map((d) => d.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0]);
    });
  });
});

describe("day labels", () => {
  it("names today and spells out older days", () => {
    expect(dayLabel(new Date(2026, 9, 9), now, 0)).toBe("Today: 0 resolved");
    expect(dayLabel(new Date(2026, 9, 8), now, 3)).toBe("Thu 8 Oct: 3 resolved");
    expect(shortDayLabel(new Date(2026, 9, 9), now)).toBe("Today");
    expect(shortDayLabel(new Date(2026, 9, 8), now)).toBe("Thu 8");
  });
});
