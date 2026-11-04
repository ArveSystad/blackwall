import type { Task } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { backlogSections } from "./backlog";
import {
  CRUMBLE_STAGGER_MS,
  backlogTasks,
  crumbleDelays,
  inboxRows,
  withDeleting,
  withDeletingLinks,
  type Crumble,
} from "./crumble";
import { makeBacklogItem, makeTask } from "./test-fixtures";

function crumble(
  task: Task,
  phase: Crumble["phase"],
  kind: Crumble["kind"] = "archive",
  itemId?: string,
): Crumble {
  return { task, kind, itemId, delayMs: 0, phase, archived: false, failures: 0 };
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

  it("keeps a crumbling deleted task's snapshot once it left the list", () => {
    const deleted = makeTask({ status: "running" });
    const other = makeTask();
    expect(
      inboxRows([other], new Map([[deleted.id, crumble(deleted, "crumbling", "delete")]])),
    ).toEqual([other, deleted]);
  });

  it("does not bring back a missing task whose crumble is an archive, or gone", () => {
    const archived = makeTask({ status: "done" });
    const deleted = makeTask();
    const crumbles = new Map([
      [archived.id, crumble(archived, "crumbling")],
      [deleted.id, crumble(deleted, "gone", "delete")],
    ]);
    expect(inboxRows([], crumbles)).toEqual([]);
  });
});

describe("withDeleting", () => {
  it("does not duplicate a deleted task still in the list", () => {
    const task = makeTask();
    expect(
      withDeleting([task], new Map([[task.id, crumble(task, "crumbling", "delete")]])),
    ).toEqual([task]);
  });

  it("feeds the Backlog the deleted snapshot while it crumbles", () => {
    const deleted = makeTask({ status: "done" });
    const crumbles = new Map([[deleted.id, crumble(deleted, "crumbling", "delete")]]);
    expect(
      backlogTasks(withDeleting([], crumbles), crumbles, new Date("2026-10-09T12:00:00.000Z")),
    ).toEqual([deleted]);
  });
});

describe("withDeletingLinks", () => {
  it("restores the link of the item that promoted a crumbling deleted task", () => {
    const task = makeTask({ status: "done" });
    const item = makeBacklogItem({ status: "promoted", taskId: null });
    const other = makeBacklogItem({ status: "promoted", taskId: null });
    const links = withDeletingLinks(
      [item, other],
      new Map([[task.id, crumble(task, "crumbling", "delete", item.id)]]),
    );
    expect(links).toEqual([{ ...item, taskId: task.id }, other]);
  });

  it("does nothing for a gone delete, an archive, or another item's crumble", () => {
    const item = makeBacklogItem({ status: "promoted", taskId: null });
    const gone = makeTask();
    const archived = makeTask({ status: "done" });
    const elsewhere = makeTask();
    const crumbles = new Map([
      [gone.id, crumble(gone, "gone", "delete", item.id)],
      [archived.id, crumble(archived, "crumbling", "archive", item.id)],
      [elsewhere.id, crumble(elsewhere, "crumbling", "delete", "b-other")],
    ]);
    expect(withDeletingLinks([item], crumbles)).toEqual([item]);
  });
});

describe("deleted tasks in backlogSections", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  function sectionsAfterDelete(task: Task) {
    const item = makeBacklogItem({ status: "promoted", taskId: null });
    const crumbles = new Map([[task.id, crumble(task, "crumbling", "delete", item.id)]]);
    const sections = backlogSections(
      withDeletingLinks([item], crumbles),
      backlogTasks(withDeleting([], crumbles), crumbles, now),
    );
    return { item, sections };
  }

  it("keeps a done promoted task as its queue item, not under other tasks", () => {
    const task = makeTask({ status: "done" });
    const { item, sections } = sectionsAfterDelete(task);
    expect(sections.items).toEqual([{ ...item, taskId: task.id }]);
    expect(sections.earlier).toEqual([]);
  });

  it("keeps a running promoted task in progress", () => {
    const task = makeTask({ status: "running" });
    const { sections } = sectionsAfterDelete(task);
    expect(sections.active).toEqual([task]);
    expect(sections.items).toEqual([]);
  });

  it("keeps an archived promoted task in the archive", () => {
    const task = makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00.000Z") });
    const { sections } = sectionsAfterDelete(task);
    expect(sections.archived).toEqual([task]);
    expect(sections.items).toEqual([]);
    expect(sections.earlier).toEqual([]);
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
