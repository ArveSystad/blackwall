import type { Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Repositories } from "../db/repositories.js";
import { TaskNotFoundError, TaskStateError } from "./engine.js";
import { DELIVERY_DONE_EVENT } from "./delivery.js";
import { WorkspaceArchiveError } from "./workspace.js";
import {
  closeEngineTest,
  openEngineTest,
  fakeArchiver,
  harness,
  seedTask,
  task,
  settle,
  dir,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("archive", () => {
  it("archives a done task and publishes it", () => {
    const done = seedTask({ status: "done" });
    const h = harness();
    const archived = h.engine.archive(done.id);
    expect(archived).toMatchObject({ status: "done", archivedAt: expect.any(Date) });
    expect(task(done.id).archivedAt).toEqual(archived.archivedAt);
    expect(h.events).toEqual([{ type: "task.upserted", payload: { task: archived } }]);
  });

  it("refuses to archive a task that is not done, unless delivered and stopped", () => {
    const h = harness();
    for (const status of ["failed", "interrupted", "needs-you", "running"] as const) {
      const seeded = seedTask({ status });
      expect(() => h.engine.archive(seeded.id)).toThrow(TaskStateError);
      expect(task(seeded.id).archivedAt).toBeNull();
    }
    for (const status of ["needs-you", "running"] as const) {
      const seeded = seedTask({ status, deliveryTargets: ["push-branch"] });
      expect(() => h.engine.archive(seeded.id)).toThrow(TaskStateError);
      expect(task(seeded.id).archivedAt).toBeNull();
    }
    expect(() => h.engine.archive("nope")).toThrow(TaskNotFoundError);
  });

  it("archives a delivered task that failed or was interrupted", () => {
    const h = harness();
    const failed = seedTask({ status: "failed", deliveryTargets: ["open-pr"] });
    const interrupted = seedTask({ status: "interrupted" });
    const run = r.runs.create(interrupted.id);
    const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
    r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, { action: "push-branch", detail: "x" });
    expect(h.engine.archive(failed.id)).toMatchObject({
      status: "failed",
      archivedAt: expect.any(Date),
    });
    expect(h.engine.archive(interrupted.id)).toMatchObject({
      status: "interrupted",
      archivedAt: expect.any(Date),
    });
  });

  it("resume unarchives an archived task", async () => {
    const h = harness();
    const failed = seedTask({
      status: "failed",
      deliveryTargets: ["push-branch"],
      archivedAt: new Date(),
    });
    const atGate = seedTask({
      status: "interrupted",
      gate: "finish",
      deliveryTargets: ["push-branch"],
      archivedAt: new Date(),
    });
    expect(h.engine.resume(failed.id)).toMatchObject({ status: "queued", archivedAt: null });
    expect(h.engine.resume(atGate.id)).toMatchObject({ status: "needs-you", archivedAt: null });
    await settle(h.engine);
  });

  it("keeps the first archive time when archived twice", () => {
    const archivedAt = new Date("2026-01-02T03:04:05Z");
    const done = seedTask({ status: "done", archivedAt });
    const h = harness();
    expect(h.engine.archive(done.id).archivedAt).toEqual(archivedAt);
    expect(task(done.id).archivedAt).toEqual(archivedAt);
  });

  it("unarchives a task", () => {
    const done = seedTask({ status: "done", archivedAt: new Date() });
    const h = harness();
    const listed = h.engine.unarchive(done.id);
    expect(listed).toMatchObject({ status: "done", archivedAt: null });
    expect(task(done.id).archivedAt).toBeNull();
    expect(h.events).toEqual([{ type: "task.upserted", payload: { task: listed } }]);
    expect(() => h.engine.unarchive("nope")).toThrow(TaskNotFoundError);
  });
});

describe("worktree removal on archive", () => {
  /** A promise resolved from outside. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  }

  const delivered = (patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {}) =>
    seedTask({
      status: "done",
      branch: "agent/x",
      worktreePath: dir,
      deliveryTargets: ["push-branch"],
      ...patch,
    });

  it("removes the worktree in the background and records it", async () => {
    const port = fakeArchiver();
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockReturnValueOnce(pending.promise);
    const h = harness(() => ({}), { archiveWorkspace: port });
    const done = delivered();

    const archived = h.engine.archive(done.id);
    expect(archived).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
    expect(port.archive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: done.id }));
    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(task(done.id)).toMatchObject({
      worktreePath: null,
      worktreeRemovedAt: expect.any(Date),
      archivedAt: expect.any(Date),
    });
    expect(h.events.at(-1)).toEqual({
      type: "task.upserted",
      payload: { task: task(done.id) },
    });
  });

  it("removes every worktree when many tasks of one repo are archived at once", async () => {
    const port = fakeArchiver();
    const h = harness(() => ({}), { archiveWorkspace: port });
    const tasks = [delivered(), delivered(), delivered()];
    for (const t of tasks) h.engine.archive(t.id);
    await settle(h.engine);
    expect(port.archive).toHaveBeenCalledTimes(3);
    for (const t of tasks) {
      expect(task(t.id)).toMatchObject({ worktreePath: null, worktreeRemovedAt: expect.any(Date) });
    }
  });

  it("restores the worktree when the task is resumed while its removal still runs", async () => {
    const port = fakeArchiver();
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockReturnValueOnce(pending.promise);
    const h = harness(
      (stage) => {
        port.order.push(stage);
        return {};
      },
      { archiveWorkspace: port },
    );
    const failed = delivered({ status: "failed" });

    h.engine.archive(failed.id);
    h.engine.resume(failed.id);
    pending.resolve({ sha: "head" });
    await settle(h.engine);

    expect(port.restore).toHaveBeenCalledOnce();
    // Rebuilt before any agent step ran.
    expect(port.order[0]).toBe(`restore ${failed.id}`);
    expect(port.order.length).toBeGreaterThan(1);
    expect(task(failed.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
  });

  it("starts one removal when unarchived and archived again while it runs", async () => {
    const port = fakeArchiver();
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockReturnValueOnce(pending.promise);
    const h = harness(() => ({}), { archiveWorkspace: port });
    const done = delivered();
    h.engine.archive(done.id);
    h.engine.unarchive(done.id);
    h.engine.archive(done.id);
    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(port.archive).toHaveBeenCalledOnce();
    expect(task(done.id)).toMatchObject({
      worktreeRemovedAt: expect.any(Date),
      archivedAt: expect.any(Date),
    });
  });

  it("logs a failed removal and keeps the worktree", async () => {
    const port = fakeArchiver();
    port.archive.mockRejectedValueOnce(new WorkspaceArchiveError("file is locked", false));
    const log = vi.fn();
    const h = harness(() => ({}), { archiveWorkspace: port, log });
    const done = delivered();
    expect(h.engine.archive(done.id).archivedAt).toEqual(expect.any(Date));
    await settle(h.engine);
    expect(log).toHaveBeenCalledWith(
      `Task ${done.id}: could not remove its worktree after archiving: file is locked`,
    );
    expect(task(done.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
  });

  it("removes the worktrees of archived tasks that still have one on startup", async () => {
    const port = fakeArchiver();
    const h = harness(() => ({}), { archiveWorkspace: port });
    const archivedAt = new Date("2026-01-01");
    const kept = delivered();
    r.tasks.update(kept.id, { archivedAt });
    const inRepo = delivered({ inRepo: true });
    r.tasks.update(inRepo.id, { archivedAt });
    const removedAt = new Date("2026-01-02");
    const removed = delivered();
    r.tasks.update(removed.id, { archivedAt, worktreeRemovedAt: removedAt });
    const unarchived = delivered();
    const before = [inRepo, removed, unarchived].map((t) => task(t.id));

    h.engine.recover();
    await settle(h.engine);

    expect(port.archive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: kept.id }));
    expect(task(kept.id)).toMatchObject({
      worktreePath: null,
      worktreeRemovedAt: expect.any(Date),
      archivedAt,
    });
    expect([inRepo, removed, unarchived].map((t) => task(t.id))).toEqual(before);
  });

  it("does not wait for those removals on startup", async () => {
    const port = fakeArchiver();
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockReturnValueOnce(pending.promise);
    const h = harness(() => ({}), { archiveWorkspace: port });
    const archived = delivered();
    r.tasks.update(archived.id, { archivedAt: new Date() });
    const running = seedTask();
    r.tasks.update(running.id, { status: "running", stage: "inform" });

    h.engine.recover();

    expect(port.archive).toHaveBeenCalledOnce();
    expect(task(archived.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
    expect(task(running.id).status).toBe("interrupted");
    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(task(archived.id)).toMatchObject({
      worktreePath: null,
      worktreeRemovedAt: expect.any(Date),
    });
  });

  it("logs a failed removal on startup and keeps the worktree", async () => {
    const port = fakeArchiver();
    port.archive.mockRejectedValueOnce(new WorkspaceArchiveError("file is locked", false));
    const log = vi.fn();
    const h = harness(() => ({}), { archiveWorkspace: port, log });
    const archived = delivered();
    r.tasks.update(archived.id, { archivedAt: new Date() });

    expect(() => h.engine.recover()).not.toThrow();
    await settle(h.engine);

    expect(log).toHaveBeenCalledWith(
      `Task ${archived.id}: could not remove its worktree after archiving: file is locked`,
    );
    expect(task(archived.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
  });

  it("records a partial removal with its leftover path, and rebuilds it on resume", async () => {
    const port = fakeArchiver();
    port.archive.mockRejectedValueOnce(new WorkspaceArchiveError("file is locked", true));
    const h = harness(() => ({}), { archiveWorkspace: port });
    const failed = delivered({ status: "failed" });
    h.engine.archive(failed.id);
    await settle(h.engine);
    expect(task(failed.id)).toMatchObject({
      worktreePath: dir,
      worktreeRemovedAt: expect.any(Date),
    });

    h.engine.resume(failed.id);
    await settle(h.engine);
    expect(port.restore).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: failed.id, worktreePath: dir }),
    );
    expect(task(failed.id).worktreeRemovedAt).toBeNull();
  });

  it("fails the resumed task without running anything when the rebuild fails", async () => {
    const port = fakeArchiver();
    port.restore.mockRejectedValueOnce(new Error("The task's archived commit was not found"));
    const h = harness(() => ({}), { archiveWorkspace: port });
    const failed = delivered({ status: "failed" });
    h.engine.archive(failed.id);
    await settle(h.engine);
    h.engine.resume(failed.id);
    await settle(h.engine);
    expect(h.calls).toEqual([]);
    expect(task(failed.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("archived commit was not found"),
    });
  });

  it("passes in-repo tasks to the port, which leaves them alone", async () => {
    const port = fakeArchiver();
    port.archive.mockResolvedValueOnce(null);
    const h = harness(() => ({}), { archiveWorkspace: port });
    const inRepo = delivered({ inRepo: true, worktreePath: "/code/app" });
    h.engine.archive(inRepo.id);
    await settle(h.engine);
    expect(port.archive).toHaveBeenCalledOnce();
    expect(task(inRepo.id)).toMatchObject({ worktreePath: "/code/app", worktreeRemovedAt: null });
  });

  it("cleans up through the port when a removed, delivered task is deleted", async () => {
    const port = fakeArchiver();
    const removeWorkspace = vi.fn(async () => undefined);
    const h = harness(() => ({}), { archiveWorkspace: port, removeWorkspace });
    const done = delivered();
    h.engine.archive(done.id);
    await h.engine.delete(done.id);
    expect(port.forget).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: done.id, worktreeRemovedAt: expect.any(Date) }),
      { keepBranch: true },
    );
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(port.exclusive).not.toHaveBeenCalled();
    expect(r.tasks.get(done.id)).toBeUndefined();
  });

  it("removes a live task's worktree on delete outside the repo queue", async () => {
    const port = fakeArchiver();
    const removeWorkspace = vi.fn(async () => undefined);
    const h = harness(() => ({}), { archiveWorkspace: port, removeWorkspace });
    const done = delivered();
    await h.engine.delete(done.id);
    expect(removeWorkspace).toHaveBeenCalledOnce();
    expect(port.exclusive).not.toHaveBeenCalled();
  });

  /** Archived tasks seeded in one repo, the first one's startup removal pending. */
  function archivedTrio(port: ReturnType<typeof fakeArchiver>) {
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockImplementationOnce(async (t) => {
      port.order.push(`archive ${t.id}`);
      return pending.promise;
    });
    const archivedAt = new Date("2026-01-01");
    const [a, b, c] = [delivered(), delivered({ status: "failed" }), delivered()];
    for (const t of [a, b, c]) r.tasks.update(t.id, { archivedAt });
    return { a: a!, b: b!, c: c!, pending };
  }

  const archivedIds = (port: ReturnType<typeof fakeArchiver>) =>
    port.archive.mock.calls.map(([t]) => t.id);

  it("runs startup removals one at a time per repo", async () => {
    const port = fakeArchiver();
    const h = harness(() => ({}), { archiveWorkspace: port });
    const { a, b, c, pending } = archivedTrio(port);

    h.engine.recover();
    await new Promise((resolve) => setImmediate(resolve));
    expect(archivedIds(port)).toEqual([a.id]);

    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(archivedIds(port)).toEqual([a.id, b.id, c.id]);
    for (const t of [a, b, c]) {
      expect(task(t.id)).toMatchObject({ worktreePath: null, worktreeRemovedAt: expect.any(Date) });
    }
  });

  it("skips a queued startup removal when its task is resumed", async () => {
    const port = fakeArchiver();
    const h = harness(
      (stage) => {
        port.order.push(stage);
        return {};
      },
      { archiveWorkspace: port },
    );
    const { a, b, c, pending } = archivedTrio(port);

    h.engine.recover();
    h.engine.resume(b.id);
    await vi.waitFor(() => expect(port.order.length).toBeGreaterThan(1));
    expect(archivedIds(port)).toEqual([a.id]);
    expect(port.exclusive).not.toHaveBeenCalled();

    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(archivedIds(port)).toEqual([a.id, c.id]);
    expect(port.restore).not.toHaveBeenCalled();
    expect(task(b.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
  });

  it("skips a queued startup removal when its task is deleted and removes it in the repo queue", async () => {
    const port = fakeArchiver();
    const removeWorkspace = vi.fn(
      async (t: Task) => void port.order.push(`removeWorkspace ${t.id}`),
    );
    const h = harness(() => ({}), { archiveWorkspace: port, removeWorkspace });
    const { a, b, c, pending } = archivedTrio(port);

    h.engine.recover();
    await h.engine.delete(b.id);
    expect(r.tasks.get(b.id)).toBeUndefined();
    expect(port.exclusive).toHaveBeenCalledExactlyOnceWith(b.repoId, expect.any(Function));
    expect(port.order).toEqual([
      `archive ${a.id}`,
      `exclusive ${b.repoId}`,
      `removeWorkspace ${b.id}`,
    ]);
    expect(archivedIds(port)).toEqual([a.id]);
    expect(port.forget).not.toHaveBeenCalled();

    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(archivedIds(port)).toEqual([a.id, c.id]);
  });

  it("skips a queued startup removal of a task unarchived before its turn", async () => {
    const port = fakeArchiver();
    const h = harness(() => ({}), { archiveWorkspace: port });
    const { a, b, c, pending } = archivedTrio(port);

    h.engine.recover();
    h.engine.unarchive(b.id);
    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(archivedIds(port)).toEqual([a.id, c.id]);
    expect(task(b.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
  });

  it("waits for a startup removal that already runs before restoring", async () => {
    const port = fakeArchiver();
    const h = harness(
      (stage) => {
        port.order.push(stage);
        return {};
      },
      { archiveWorkspace: port },
    );
    const failed = delivered({ status: "failed" });
    r.tasks.update(failed.id, { archivedAt: new Date() });
    const pending = deferred<{ sha: string } | null>();
    port.archive.mockImplementationOnce(async (t) => {
      port.order.push(`archive ${t.id}`);
      return pending.promise;
    });

    h.engine.recover();
    h.engine.resume(failed.id);
    await new Promise((resolve) => setImmediate(resolve));
    expect(port.order).toEqual([`archive ${failed.id}`]);

    pending.resolve({ sha: "head" });
    await settle(h.engine);
    expect(port.order.slice(0, 2)).toEqual([`archive ${failed.id}`, `restore ${failed.id}`]);
  });
});
