import type { QuotaState, RepoBacklogRunner } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  backlogCrumbleDelays,
  backlogSections,
  countdown,
  dependencyChoices,
  itemState,
  moveItem,
  nextBacklogItem,
  pendingCount,
  referenceRepoChoice,
  reorderIds,
  repoStatusLine,
  rowAction,
  runnerStatus,
  syncControl,
  type RunnerStatusInput,
} from "./backlog";
import { CRUMBLE_STAGGER_MS, backlogTasks } from "./crumble";
import { makeBacklogItem, makeTask } from "./test-fixtures";

describe("referenceRepoChoice", () => {
  const repo = { id: "app", referenceRepoIds: ["lib", "api"] };

  it("shows the repo's list and sends null until the user picks", () => {
    expect(referenceRepoChoice(repo, null)).toEqual({ ids: ["lib", "api"], override: null });
    expect(referenceRepoChoice(undefined, null)).toEqual({ ids: [], override: null });
  });

  it("sends a pick that differs from the repo's list", () => {
    expect(referenceRepoChoice(repo, { repoId: "app", ids: ["lib"] })).toEqual({
      ids: ["lib"],
      override: ["lib"],
    });
    expect(referenceRepoChoice(repo, { repoId: "app", ids: [] })).toEqual({
      ids: [],
      override: [],
    });
  });

  it("sends null for a pick with the repo's own ids in any order", () => {
    expect(referenceRepoChoice(repo, { repoId: "app", ids: ["api", "lib"] }).override).toBeNull();
  });

  it("drops a pick made in another repo", () => {
    expect(referenceRepoChoice(repo, { repoId: "other", ids: ["app"] })).toEqual({
      ids: ["lib", "api"],
      override: null,
    });
  });

  it("shows an edited item's override", () => {
    const item = makeBacklogItem({ repoId: "app", referenceRepoIds: ["api"] });
    const pick = item.referenceRepoIds && { repoId: item.repoId, ids: item.referenceRepoIds };
    expect(referenceRepoChoice(repo, pick)).toEqual({ ids: ["api"], override: ["api"] });
  });
});

describe("pendingCount", () => {
  it("counts items not yet promoted", () => {
    expect(
      pendingCount([
        makeBacklogItem(),
        makeBacklogItem({ status: "paused" }),
        makeBacklogItem({ status: "promoted", taskId: "t1" }),
      ]),
    ).toBe(2);
  });
});

describe("backlogSections", () => {
  const at = (minute: number) => new Date(`2026-10-08T10:${String(minute).padStart(2, "0")}:00Z`);

  it("puts active tasks on top, needs-you first, each newest first, from the backlog or not", () => {
    const running = makeTask({ status: "running", updatedAt: at(1) });
    const queued = makeTask({ status: "queued", updatedAt: at(3) });
    const needsOld = makeTask({ status: "needs-you", updatedAt: at(2) });
    const needsNew = makeTask({ status: "needs-you", updatedAt: at(4) });
    const promoted = makeBacklogItem({ status: "promoted", taskId: running.id });
    const { active } = backlogSections([promoted], [running, queued, needsOld, needsNew]);
    expect(active).toEqual([needsNew, needsOld, queued, running]);
  });

  it("hides promoted items whose task is active, keeping ones whose task finished or is gone", () => {
    const live = makeTask({ status: "running" });
    const finished = makeTask({ status: "done" });
    const waiting = makeBacklogItem();
    const paused = makeBacklogItem({ status: "paused" });
    const toLive = makeBacklogItem({ status: "promoted", taskId: live.id });
    const toDone = makeBacklogItem({ status: "promoted", taskId: finished.id });
    const toGone = makeBacklogItem({ status: "promoted", taskId: "gone" });
    const { items } = backlogSections([waiting, toLive, paused, toDone, toGone], [live, finished]);
    expect(items).toEqual([waiting, paused, toDone, toGone]);
  });

  it("lists nothing when the only item became an active task", () => {
    const live = makeTask({ status: "queued" });
    const item = makeBacklogItem({ status: "promoted", taskId: live.id });
    expect(backlogSections([item], [live]).items).toEqual([]);
  });

  it("lists finished tasks no item links to, newest first", () => {
    const done = makeTask({ status: "done", updatedAt: at(1) });
    const failed = makeTask({ status: "failed", updatedAt: at(3) });
    const interrupted = makeTask({ status: "interrupted", updatedAt: at(2) });
    const fromBacklog = makeTask({ status: "done", updatedAt: at(4) });
    const item = makeBacklogItem({ status: "promoted", taskId: fromBacklog.id });
    const { earlier } = backlogSections([item], [done, failed, interrupted, fromBacklog]);
    expect(earlier).toEqual([failed, interrupted, done]);
  });

  it("without tasks lists every item in pick order", () => {
    const items = [
      makeBacklogItem(),
      makeBacklogItem({ status: "promoted", taskId: "t-any" }),
      makeBacklogItem({ status: "paused" }),
    ];
    expect(backlogSections(items, [])).toEqual({
      active: [],
      items,
      earlier: [],
      archived: [],
      archivable: [],
    });
  });

  it("moves archived tasks out of earlier into the archive, most recently archived first", () => {
    const listed = makeTask({ status: "done" });
    const older = makeTask({ status: "done", archivedAt: at(1), updatedAt: at(9) });
    const newer = makeTask({ status: "done", archivedAt: at(5), updatedAt: at(2) });
    const { earlier, archived } = backlogSections([], [older, listed, newer]);
    expect(earlier).toEqual([listed]);
    expect(archived).toEqual([newer, older]);
  });

  it("hides promoted items whose task is archived", () => {
    const archivedTask = makeTask({ status: "done", archivedAt: at(1) });
    const doneTask = makeTask({ status: "done" });
    const toArchived = makeBacklogItem({ status: "promoted", taskId: archivedTask.id });
    const toDone = makeBacklogItem({ status: "promoted", taskId: doneTask.id });
    const { items, archived } = backlogSections([toArchived, toDone], [archivedTask, doneTask]);
    expect(items).toEqual([toDone]);
    expect(archived).toEqual([archivedTask]);
  });

  it("offers only unarchived done tasks for archiving", () => {
    const done = makeTask({ status: "done" });
    const archived = makeTask({ status: "done", archivedAt: at(1) });
    const failed = makeTask({ status: "failed" });
    const interrupted = makeTask({ status: "interrupted" });
    const running = makeTask({ status: "running" });
    const { archivable } = backlogSections([], [done, archived, failed, interrupted, running]);
    expect(archivable).toEqual([done]);
  });

  it("hides a promoted item whose task crumbled out, listing the task as archived", () => {
    const task = makeTask({ status: "done" });
    const item = makeBacklogItem({ status: "promoted", taskId: task.id });
    const now = at(30);
    const crumbles = new Map([
      [task.id, { task, delayMs: 0, phase: "gone" as const, archived: false, failures: 0 }],
    ]);
    const { items, archived, archivable } = backlogSections(
      [item],
      backlogTasks([task], crumbles, now),
    );
    expect(items).toEqual([]);
    expect(archived).toEqual([{ ...task, archivedAt: now }]);
    expect(archivable).toEqual([]);
  });
});

describe("backlogCrumbleDelays", () => {
  const at = (minute: number) => new Date(`2026-10-08T10:${String(minute).padStart(2, "0")}:00Z`);

  it("staggers queue items' tasks, then other tasks, in display order", () => {
    const queuedLater = makeTask({ status: "done", updatedAt: at(9) });
    const queuedFirst = makeTask({ status: "done", updatedAt: at(1) });
    const otherOld = makeTask({ status: "done", updatedAt: at(2) });
    const otherNew = makeTask({ status: "done", updatedAt: at(5) });
    const failed = makeTask({ status: "failed", updatedAt: at(7) });
    const items = [
      makeBacklogItem({ status: "promoted", taskId: queuedFirst.id }),
      makeBacklogItem(),
      makeBacklogItem({ status: "promoted", taskId: queuedLater.id }),
    ];
    const sections = backlogSections(items, [otherOld, queuedLater, failed, otherNew, queuedFirst]);
    expect([...backlogCrumbleDelays(sections)]).toEqual([
      [queuedFirst.id, 0],
      [queuedLater.id, CRUMBLE_STAGGER_MS],
      [otherNew.id, 2 * CRUMBLE_STAGGER_MS],
      [otherOld.id, 3 * CRUMBLE_STAGGER_MS],
    ]);
  });

  it("gives a lone task no delay", () => {
    const task = makeTask({ status: "done" });
    expect(backlogCrumbleDelays(backlogSections([], [task])).get(task.id)).toBe(0);
  });
});

describe("moveItem and reorderIds", () => {
  const n0 = makeBacklogItem();
  const n1 = makeBacklogItem();
  const n2 = makeBacklogItem();
  const n3 = makeBacklogItem();
  const items = [n0, n1, n2, n3];

  it("moves across the whole list and lists every item once", () => {
    expect(moveItem(items, n2.id, -1)).toEqual([n0.id, n2.id, n1.id, n3.id]);
    expect(moveItem(items, n2.id, 1)).toEqual([n0.id, n1.id, n3.id, n2.id]);
    expect(moveItem(items, n1.id, -1)).toEqual([n1.id, n0.id, n2.id, n3.id]);
  });

  it("stops at either end of the list", () => {
    expect(moveItem(items, n0.id, -1)).toBeNull();
    expect(moveItem(items, n3.id, 1)).toBeNull();
  });

  it("steps past items not shown, still listing every item", () => {
    const shown = new Set([n0.id, n1.id, n3.id]);
    expect(moveItem(items, n3.id, -1, shown)).toEqual([n0.id, n3.id, n1.id, n2.id]);
    expect(moveItem(items, n1.id, 1, shown)).toEqual([n0.id, n2.id, n3.id, n1.id]);
    expect(moveItem(items, n3.id, 1, shown)).toBeNull();
  });

  it("drops onto any other item, never onto itself", () => {
    expect(reorderIds(items, n3.id, n1.id)).toEqual([n0.id, n3.id, n1.id, n2.id]);
    expect(reorderIds(items, n1.id, n3.id)).toEqual([n0.id, n2.id, n3.id, n1.id]);
    expect(reorderIds(items, n3.id, n0.id)).toEqual([n3.id, n0.id, n1.id, n2.id]);
    expect(reorderIds(items, n0.id, n3.id)).toEqual([n1.id, n2.id, n3.id, n0.id]);
    expect(reorderIds(items, n1.id, n1.id)).toBeNull();
  });
});

describe("nextBacklogItem", () => {
  it("takes the first waiting item, skipping paused and promoted ones", () => {
    const paused = makeBacklogItem({ status: "paused" });
    const promoted = makeBacklogItem({ status: "promoted", taskId: "t1" });
    const waiting = makeBacklogItem();
    expect(nextBacklogItem([paused, promoted, waiting])).toBe(waiting);
  });

  it("runs an unmet dependency before the item that needs it", () => {
    const dep = makeBacklogItem();
    const item = makeBacklogItem({
      dependsOn: [dep.id],
      blocked: true,
      blockedBy: [dep.id],
    });
    expect(nextBacklogItem([item, dep])).toBe(dep);
  });

  it("leaves out skipped items and is blocked by a missing dependency", () => {
    const a = makeBacklogItem();
    const b = makeBacklogItem({ blocked: true, blockedBy: ["gone"] });
    expect(nextBacklogItem([a, b], new Set([a.id]))).toBeUndefined();
  });
});

describe("itemState", () => {
  const dep = makeBacklogItem({ title: "Schema first" });
  const titles = new Map([[dep.id, dep.title]]);
  const task = makeTask({ status: "running" });
  const tasks = new Map([[task.id, task]]);

  it("says next up, paused, blocked by title, or promoted with its task", () => {
    const blocked = makeBacklogItem({ blocked: true, blockedBy: [dep.id, "gone"] });
    const ctx = { nextId: dep.id, titles, tasks };
    expect(itemState(dep, ctx)).toEqual({ kind: "next" });
    expect(itemState(makeBacklogItem({ status: "paused" }), ctx)).toEqual({ kind: "paused" });
    expect(itemState(blocked, ctx)).toEqual({
      kind: "blocked",
      by: ["Schema first", "a deleted item"],
    });
    expect(itemState(makeBacklogItem({ status: "promoted", taskId: task.id }), ctx)).toEqual({
      kind: "promoted",
      task,
    });
    expect(itemState(makeBacklogItem(), ctx)).toEqual({ kind: "waiting" });
  });
});

describe("rowAction", () => {
  it("edits an item not yet promoted", () => {
    expect(rowAction({ kind: "waiting" })).toEqual({ kind: "edit" });
    expect(rowAction({ kind: "paused" })).toEqual({ kind: "edit" });
    expect(rowAction({ kind: "next" })).toEqual({ kind: "edit" });
    expect(rowAction({ kind: "blocked", by: ["x"] })).toEqual({ kind: "edit" });
  });

  it("opens a promoted item's task, or does nothing when the task is gone", () => {
    const task = makeTask({ id: "t1" });
    expect(rowAction({ kind: "promoted", task })).toEqual({ kind: "open-task", taskId: "t1" });
    expect(rowAction({ kind: "promoted", task: undefined })).toBeNull();
  });
});

describe("runnerStatus", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const runner: RepoBacklogRunner = {
    enabled: true,
    haltedTaskId: null,
    haltedAt: null,
    autonomous: false,
    includeRemoteIssues: false,
  };
  const settings = {
    backlogRunner: true,
    maxTasksPerRepo: 3,
    maxBacklogTasksPerRepo: 1,
    stopBacklogOnNeedsYou: true,
  };
  const status = (overrides: Partial<RunnerStatusInput> = {}) =>
    runnerStatus({
      settings,
      repo: undefined,
      runner,
      items: [makeBacklogItem({ title: "Add login" })],
      tasks: [],
      quota: [],
      clisFor: () => ["claude"],
      now,
      ...overrides,
    });

  it("names the next item when idle", () => {
    expect(status()).toMatchObject({ tone: "ready", label: "Idle", detail: "Next: Add login" });
  });

  it("says an empty queue picks up remote issues when remote issues are on", () => {
    expect(status({ items: [] }).detail).toBe("Queue empty. Nothing to run.");
    expect(status({ items: [], runner: { ...runner, includeRemoteIssues: true } })).toMatchObject({
      tone: "idle",
      label: "Idle",
      detail: "Queue empty. Picks up the next open GitHub or Jira issue.",
    });
  });

  it("is off globally or per repo", () => {
    expect(status({ settings: { ...settings, backlogRunner: false } }).tone).toBe("off");
    expect(status({ runner: { ...runner, enabled: false } }).detail).toMatch(/this repo/);
  });

  it("is halted by a failed backlog task", () => {
    const failed = makeTask({ status: "failed", title: "Broken" });
    const result = status({
      runner: { ...runner, haltedTaskId: failed.id },
      tasks: [failed],
    });
    expect(result).toMatchObject({ tone: "halted", haltedTaskId: failed.id });
    expect(result.detail).toContain("Broken");
  });

  it("waits for queued tasks, full slots, backlog tasks and needs-you", () => {
    expect(status({ tasks: [makeTask({ status: "queued" })] }).detail).toBe(
      "1 queued task goes first.",
    );
    const running = [1, 2, 3].map(() => makeTask({ status: "running" }));
    expect(status({ tasks: running }).detail).toBe("3 tasks running.");

    const task = makeTask({ status: "running" });
    const promoted = makeBacklogItem({ status: "promoted", taskId: task.id });
    expect(status({ items: [promoted, makeBacklogItem()], tasks: [task] }).detail).toBe(
      "1 backlog task running.",
    );

    const waiting = makeTask({ status: "needs-you", title: "Review me" });
    const link = makeBacklogItem({ status: "promoted", taskId: waiting.id });
    const items = [link, makeBacklogItem()];
    expect(status({ items, tasks: [waiting] }).detail).toBe("Backlog task “Review me” needs you.");
    expect(
      status({ items, tasks: [waiting], settings: { ...settings, stopBacklogOnNeedsYou: false } })
        .tone,
    ).toBe("ready");
  });

  it("caps running backlog tasks by the repo's own cap over the global one", () => {
    const tasks = [makeTask({ status: "running" }), makeTask({ status: "running" })];
    const items = [
      ...tasks.map((t) => makeBacklogItem({ status: "promoted", taskId: t.id })),
      makeBacklogItem({ title: "Add login" }),
    ];
    expect(status({ items, tasks: tasks.slice(0, 1), repo: { maxBacklogTasks: 2 } }).tone).toBe(
      "ready",
    );
    expect(status({ items, tasks, repo: { maxBacklogTasks: 2 } }).detail).toBe(
      "2 backlog tasks running.",
    );
    expect(
      status({ items, tasks: tasks.slice(0, 1), repo: { maxBacklogTasks: null } }).detail,
    ).toBe("1 backlog task running.");
    expect(
      status({
        items,
        tasks: tasks.slice(0, 1),
        settings: { ...settings, maxBacklogTasksPerRepo: 3 },
        repo: { maxBacklogTasks: 1 },
      }).detail,
    ).toBe("1 backlog task running.");
  });

  it("is paused while the next item's CLI is on a usage limit", () => {
    const quota: QuotaState[] = [{ cli: "claude", pausedUntil: new Date("2026-10-08T12:12:00Z") }];
    const result = status({ quota });
    expect(result.tone).toBe("paused");
    expect(result.detail).toMatch(/^Claude Code quota resets .+ \(in 12m\)$/);
    // An item on another CLI still runs.
    expect(status({ quota, clisFor: () => ["copilot"] }).tone).toBe("ready");
  });

  it("explains an empty or stuck backlog", () => {
    expect(status({ items: [] }).detail).toBe("Queue empty. Nothing to run.");
    expect(status({ items: [makeBacklogItem({ status: "paused" })] }).detail).toMatch(
      /paused or blocked/,
    );
  });
});

describe("countdown", () => {
  it("formats seconds, minutes and hours", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(countdown(new Date("2026-10-08T12:00:45Z"), now)).toBe("45s");
    expect(countdown(new Date("2026-10-08T12:12:00Z"), now)).toBe("12m");
    expect(countdown(new Date("2026-10-08T14:05:00Z"), now)).toBe("2h 05m");
    expect(countdown(new Date("2026-10-08T11:00:00Z"), now)).toBe("0s");
  });
});

describe("repoStatusLine", () => {
  const on = { enabled: true, haltedTaskId: null };
  const line = (overrides: Partial<Parameters<typeof repoStatusLine>[0]> = {}): string =>
    repoStatusLine({ settings: { backlogRunner: true }, runner: on, tasks: [], ...overrides });

  it("counts no running tasks with auto-start enabled", () => {
    expect(line()).toBe("0 tasks running · auto-start enabled");
  });

  it("says task in the singular", () => {
    expect(line({ tasks: [makeTask({ status: "running" })] })).toBe(
      "1 task running · auto-start enabled",
    );
  });

  it("counts only running tasks", () => {
    const tasks = [
      makeTask({ status: "running" }),
      makeTask({ status: "running" }),
      makeTask({ status: "running" }),
      makeTask({ status: "queued" }),
      makeTask({ status: "needs-you" }),
      makeTask({ status: "done" }),
    ];
    expect(line({ tasks })).toBe("3 tasks running · auto-start enabled");
  });

  it("is disabled when the runner is off globally or for the repo", () => {
    expect(line({ settings: { backlogRunner: false } })).toBe(
      "0 tasks running · auto-start disabled",
    );
    expect(line({ runner: { enabled: false, haltedTaskId: null } })).toBe(
      "0 tasks running · auto-start disabled",
    );
  });

  it("is halted while a failed task holds the runner", () => {
    expect(line({ runner: { enabled: true, haltedTaskId: "t1" } })).toBe(
      "0 tasks running · auto-start halted",
    );
  });
});

describe("syncControl", () => {
  const sync = (ahead: number, behind: number) => ({ branch: "main", ahead, behind });

  it("shows nothing without a status or with nothing to push", () => {
    expect(syncControl(undefined)).toBeNull();
    expect(syncControl(null)).toBeNull();
    expect(syncControl(sync(0, 0))).toBeNull();
    expect(syncControl(sync(0, 2))).toBeNull();
  });

  it("offers a push with the commit count", () => {
    expect(syncControl(sync(1, 0))).toEqual({
      kind: "push",
      label: "Push 1 commit to main",
      title: "Not yet on origin/main",
    });
    expect(syncControl(sync(3, 0))).toMatchObject({ label: "Push 3 commits to main" });
  });

  it("asks for a pull when main has diverged", () => {
    expect(syncControl(sync(2, 1))).toEqual({
      kind: "diverged",
      text: "main diverged from origin/main; pull first",
    });
  });
});

describe("dependencyChoices", () => {
  const byId = (tasks: ReturnType<typeof makeTask>[]) => new Map(tasks.map((t) => [t.id, t]));

  it("keeps waiting and paused items, leaving out the item itself", () => {
    const self = makeBacklogItem();
    const waiting = makeBacklogItem();
    const paused = makeBacklogItem({ status: "paused" });
    expect(dependencyChoices([self, waiting, paused], new Map(), self.id, [])).toEqual([
      { item: waiting, task: undefined },
      { item: paused, task: undefined },
    ]);
  });

  it("keeps promoted items whose task is under way, with the task, in pick order", () => {
    const running = makeTask({ status: "running" });
    const queued = makeTask({ status: "queued" });
    const needsYou = makeTask({ status: "needs-you" });
    const toNeedsYou = makeBacklogItem({ status: "promoted", taskId: needsYou.id });
    const waiting = makeBacklogItem();
    const toRunning = makeBacklogItem({ status: "promoted", taskId: running.id });
    const toQueued = makeBacklogItem({ status: "promoted", taskId: queued.id });
    expect(
      dependencyChoices(
        [toNeedsYou, waiting, toRunning, toQueued],
        byId([running, queued, needsYou]),
        undefined,
        [],
      ),
    ).toEqual([
      { item: toNeedsYou, task: needsYou },
      { item: waiting, task: undefined },
      { item: toRunning, task: running },
      { item: toQueued, task: queued },
    ]);
  });

  it("drops promoted items whose task is finished, archived or gone, unless chosen", () => {
    const done = makeTask({ status: "done" });
    const failed = makeTask({ status: "failed" });
    const interrupted = makeTask({ status: "interrupted" });
    const archived = makeTask({ status: "running", archivedAt: new Date(1) });
    const tasks = byId([done, failed, interrupted, archived]);
    const items = [
      makeBacklogItem({ status: "promoted", taskId: done.id }),
      makeBacklogItem({ status: "promoted", taskId: failed.id }),
      makeBacklogItem({ status: "promoted", taskId: interrupted.id }),
      makeBacklogItem({ status: "promoted", taskId: archived.id }),
      makeBacklogItem({ status: "promoted", taskId: "gone" }),
      makeBacklogItem({ status: "promoted", taskId: null }),
    ];
    expect(dependencyChoices(items, tasks, undefined, [])).toEqual([]);
    const chosen = [items[0]!, items[4]!, items[5]!];
    expect(
      dependencyChoices(
        items,
        tasks,
        undefined,
        chosen.map((i) => i.id),
      ),
    ).toEqual([
      { item: items[0], task: done },
      { item: items[4], task: undefined },
      { item: items[5], task: undefined },
    ]);
  });
});
