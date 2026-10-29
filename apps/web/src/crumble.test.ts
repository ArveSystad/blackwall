import type { Task } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  CRUMBLE_STAGGER_MS,
  backlogTasks,
  crumbleDelays,
  inboxRows,
  type Crumble,
} from "./crumble";
import { makeTask } from "./test-fixtures";

function crumble(task: Task, phase: Crumble["phase"]): Crumble {
  return { task, delayMs: 0, phase, archived: false, failures: 0 };
}

describe("crumbleDelays", () => {
  it("staggers in inbox order: needs you (with failed CI), then recent, newest first", () => {
    const older = makeTask({ status: "done", updatedAt: new Date("2026-10-08T10:00:00.000Z") });
    const newer = makeTask({ status: "done", updatedAt: new Date("2026-10-09T10:00:00.000Z") });
    const ciFailed = makeTask({
      status: "done",
      updatedAt: new Date("2026-10-01T10:00:00.000Z"),
      ci: {
        state: "failed",
        sha: "abc1234",
        host: "github.com",
        owner: "acme",
        repo: "web",
        checks: [],
        hint: null,
        startedAt: "2026-10-01T10:00:00.000Z",
        updatedAt: "2026-10-01T10:05:00.000Z",
        finishedAt: "2026-10-01T10:05:00.000Z",
      },
    });
    const delays = crumbleDelays([older, newer, ciFailed]);
    expect([...delays]).toEqual([
      [ciFailed.id, 0],
      [newer.id, CRUMBLE_STAGGER_MS],
      [older.id, 2 * CRUMBLE_STAGGER_MS],
    ]);
  });

  it("gives a single task no delay", () => {
    const task = makeTask({ status: "done" });
    expect(crumbleDelays([task]).get(task.id)).toBe(0);
  });
});

describe("inboxRows", () => {
  it("drops gone rows", () => {
    const a = makeTask({ status: "done" });
    const b = makeTask({ status: "done" });
    expect(inboxRows([a, b], new Map([[a.id, crumble(a, "gone")]]))).toEqual([b]);
  });

  it("shows the snapshot of a crumbling row, even once the live task is archived", () => {
    const snapshot = makeTask({ status: "done" });
    const live = { ...snapshot, archivedAt: new Date("2026-10-09T10:00:00.000Z") };
    const rows = inboxRows([live], new Map([[snapshot.id, crumble(snapshot, "crumbling")]]));
    expect(rows).toEqual([snapshot]);
    expect(rows[0]?.archivedAt).toBeNull();
  });

  it("shows the live task for a failed row", () => {
    const snapshot = makeTask({ status: "done" });
    const live = { ...snapshot, title: "Renamed" };
    expect(inboxRows([live], new Map([[snapshot.id, crumble(snapshot, "failed")]]))).toEqual([
      live,
    ]);
  });

  it("leaves tasks with no crumble untouched", () => {
    const tasks = [makeTask(), makeTask({ status: "done" })];
    expect(inboxRows(tasks, new Map())).toEqual(tasks);
  });
});

describe("backlogTasks", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("leaves tasks with no crumble untouched", () => {
    const tasks = [makeTask(), makeTask({ status: "done" })];
    expect(backlogTasks(tasks, new Map(), now)).toEqual(tasks);
  });

  it("shows the snapshot of a crumbling row, even once the live task is archived", () => {
    const snapshot = makeTask({ status: "done" });
    const live = { ...snapshot, archivedAt: new Date("2026-10-09T10:00:00.000Z") };
    expect(
      backlogTasks([live], new Map([[snapshot.id, crumble(snapshot, "crumbling")]]), now),
    ).toEqual([snapshot]);
  });

  it("shows a gone row as archived at `now` until the live task is", () => {
    const snapshot = makeTask({ status: "done" });
    expect(
      backlogTasks([snapshot], new Map([[snapshot.id, crumble(snapshot, "gone")]]), now),
    ).toEqual([{ ...snapshot, archivedAt: now }]);
  });

  it("shows the live task for a gone row once it is archived", () => {
    const snapshot = makeTask({ status: "done" });
    const live = { ...snapshot, archivedAt: new Date("2026-10-09T10:00:00.000Z") };
    expect(backlogTasks([live], new Map([[snapshot.id, crumble(snapshot, "gone")]]), now)).toEqual([
      live,
    ]);
  });

  it("shows the live task for a failed row", () => {
    const snapshot = makeTask({ status: "done" });
    const live = { ...snapshot, title: "Renamed" };
    expect(
      backlogTasks([live], new Map([[snapshot.id, crumble(snapshot, "failed")]]), now),
    ).toEqual([live]);
  });
});
