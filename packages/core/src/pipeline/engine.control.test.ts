import { TASK_STOPPED_ERROR, type Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../agents/adapters/types.js";
import { GitError } from "../git/service.js";
import { createRepoRenameLocks } from "../repos/rename-lock.js";
import { RESUME_PROMPT, TaskNotFoundError, TaskStateError, type StageHandlers } from "./engine.js";
import { DELIVERY_DONE_EVENT, ISSUE_COMMENT_EVENT } from "./delivery.js";
import { InvalidGateResponseError } from "./transitions.js";
import {
  closeEngineTest,
  openEngineTest,
  createDefaultStages,
  ISSUE_COMMENT_URL,
  harness,
  seedTask,
  task,
  settle,
  prOrigin,
  stepsOf,
  lastStep,
  dir,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("stop and delete", () => {
  it("stops a running task, kills its agent and resumes the same session", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage) =>
      stage === "inform" && hang ? { hang: true, sessionId: "inform-1" } : {},
    );
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("inform-1"));

    const stopped = await h.engine.stop(seeded.id);
    expect(stopped).toMatchObject({ status: "interrupted", error: TASK_STOPPED_ERROR });
    expect(lastStep(seeded.id)).toMatchObject({ status: "interrupted", sessionId: "inform-1" });
    expect(h.calls[0]!.options.signal?.aborted).toBe(true);
    expect(h.engine.activeTaskIds()).toEqual([]);

    hang = false;
    expect(h.engine.resume(seeded.id)).toMatchObject({ status: "queued", error: null });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.calls.some((c) => c.options.resumeSessionId === "inform-1")).toBe(true);
  });

  it("starts a step afresh when the CLI lost its session", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage, options) => {
      if (stage === "inform" && hang) return { hang: true, sessionId: "inform-1" };
      if (options.resumeSessionId === "inform-1") return { missingSession: true };
      return {};
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("inform-1"));
    await h.engine.stop(seeded.id);
    const informSteps = () => stepsOf(seeded.id).filter((s) => s.stage === "inform");
    const stepsBefore = informSteps().length;
    const callsBefore = h.calls.length;

    hang = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      error: null,
    });
    const informCalls = h.calls
      .slice(callsBefore)
      .filter((c) => c.stage === "inform" || c.options.resumeSessionId === "inform-1");
    expect(informCalls).toHaveLength(2);
    expect(informCalls[0]!.options).toMatchObject({
      resumeSessionId: "inform-1",
      prompt: RESUME_PROMPT,
    });
    expect(informCalls[1]!.stage).toBe("inform");
    expect(informCalls[1]!.options.resumeSessionId).toBeUndefined();
    // The same step ran afresh: no extra step for the visit.
    expect(informSteps()).toHaveLength(stepsBefore);
    const inform = informSteps().at(-1)!;
    expect(inform.status).toBe("succeeded");
    expect(inform.sessionId).not.toBe("inform-1");
  });

  it("fails the task when the fresh start after a lost session fails too", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage, options) => {
      if (stage === "inform" && hang) return { hang: true, sessionId: "inform-1" };
      if (options.resumeSessionId === "inform-1") return { missingSession: true };
      if (stage === "inform") return { fail: "boom" };
      return {};
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("inform-1"));
    await h.engine.stop(seeded.id);
    const callsBefore = h.calls.length;

    hang = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "failed", error: "boom" });
    // One resume attempt and one fresh start: no loop.
    expect(h.calls.slice(callsBefore)).toHaveLength(2);
  });

  it("stops a queued task without starting it", async () => {
    const gate = new Promise<void>(() => undefined);
    const stages: StageHandlers = { ...createDefaultStages(), inform: () => gate };
    const h = harness(() => ({}), { stages, maxPerRepo: 1 });
    const first = seedTask();
    const second = seedTask();
    h.engine.enqueue(first.id);
    h.engine.enqueue(second.id);
    expect(h.engine.queuedTaskIds()).toEqual([second.id]);

    const stopped = await h.engine.stop(second.id);
    expect(stopped).toMatchObject({ status: "interrupted", error: TASK_STOPPED_ERROR });
    expect(h.engine.queuedTaskIds()).toEqual([]);
    expect(r.runs.listByTask(second.id)).toEqual([]);
  });

  it("fails the task with what to do when preparing the worktree hits a git error", async () => {
    const seeded = seedTask();
    const h = harness(() => ({}), {
      prepareWorkspace: async () => {
        throw new GitError(
          ["fetch", "origin"],
          "fatal: Authentication failed for 'https://user:secret@github.com/acme/app.git/'\n",
          128,
        );
      },
    });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "failed",
      error:
        "Git could not authenticate to the remote. Set up git credentials (credential manager or SSH key) for it; this is not the blackwall token. (fatal: Authentication failed for 'https://github.com/acme/app.git/')",
    });
  });

  it("prepares an in-repo task's workspace again on every drive, not a worktree task's", async () => {
    const prepareWorkspace = vi.fn(async (t: Task) => ({
      branch: t.branch ?? `agent/${t.id}`,
      worktreePath: dir,
    }));
    const h = harness(() => ({}), { prepareWorkspace });
    const inRepo = seedTask({ inRepo: true, branch: "agent/x", worktreePath: dir });
    const worktree = seedTask({ branch: "agent/y", worktreePath: dir });
    h.engine.enqueue(inRepo.id);
    h.engine.enqueue(worktree.id);
    await settle(h.engine);
    expect(prepareWorkspace.mock.calls.map(([t]) => t.id)).toEqual([inRepo.id]);
  });

  it("leaves a task that is neither queued, running nor waiting as it is", async () => {
    const seeded = seedTask();
    const h = harness((stage) => (stage === "inform" ? { fail: "boom" } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    const failed = task(seeded.id);
    expect(failed).toMatchObject({ status: "failed", error: "boom" });
    expect(await h.engine.stop(seeded.id)).toEqual(failed);
  });

  it("stops a task waiting at a gate and resumes it there", async () => {
    const seeded = seedTask();
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    const callsBefore = h.calls.length;

    expect(await h.engine.stop(seeded.id)).toMatchObject({
      status: "interrupted",
      gate: "plan-approval",
      error: TASK_STOPPED_ERROR,
    });
    await expect(
      h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);

    expect(h.engine.resume(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      error: null,
    });
    expect(h.engine.queuedTaskIds()).toEqual([]);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.calls).toHaveLength(callsBefore);
  });

  it("stops a task waiting on grill answers and keeps its questions", async () => {
    const seeded = seedTask();
    let grills = 0;
    const h = harness((stage) =>
      stage === "plan-review" && grills++ === 0
        ? { structured: { questions: [{ question: "Lock after how many?", needsHuman: true }] } }
        : {},
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "questions" });
    const [question] = r.grillQuestions.listByTask(seeded.id);
    const callsBefore = h.calls.length;

    expect(await h.engine.stop(seeded.id)).toMatchObject({
      status: "interrupted",
      gate: "questions",
    });
    await expect(h.engine.answerQuestion(seeded.id, question!.id, { answer: "5" })).rejects.toThrow(
      TaskStateError,
    );

    expect(h.engine.resume(seeded.id)).toMatchObject({ status: "needs-you", gate: "questions" });
    expect(r.grillQuestions.listByTask(seeded.id)).toEqual([question]);
    expect(h.calls).toHaveLength(callsBefore);
  });

  it("deletes a running task with its workspace and history", async () => {
    const seeded = seedTask();
    const removed: Task[] = [];
    const h = harness((stage) => (stage === "inform" ? { hang: true, sessionId: "s" } : {}), {
      removeWorkspace: async (t) => void removed.push(t),
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("s"));

    await h.engine.delete(seeded.id);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
    expect(r.runs.listByTask(seeded.id)).toEqual([]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ id: seeded.id, worktreePath: dir });
    expect(h.events.at(-1)).toEqual({ type: "task.removed", payload: { taskId: seeded.id } });
    await expect(h.engine.delete(seeded.id)).rejects.toThrow(TaskNotFoundError);
  });

  it("deletes a task that never got a worktree without touching git", async () => {
    const seeded = seedTask();
    const removeWorkspace = vi.fn(async () => undefined);
    const beforeDelete = vi.fn(async () => undefined);
    const h = harness(() => ({}), { removeWorkspace, beforeDelete });
    await h.engine.delete(seeded.id);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(beforeDelete).toHaveBeenCalledWith(seeded.id);
  });

  it("waits for beforeDelete before removing the worktree", async () => {
    const seeded = seedTask({ worktreePath: dir });
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const h = harness(() => ({}), {
      beforeDelete: async (taskId) => {
        order.push(`beforeDelete ${taskId}`);
        await released;
      },
      removeWorkspace: async () => void order.push("removeWorkspace"),
    });
    const deleting = h.engine.delete(seeded.id);
    await vi.waitFor(() => expect(order).toEqual([`beforeDelete ${seeded.id}`]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([`beforeDelete ${seeded.id}`]);
    expect(r.tasks.get(seeded.id)).toBeDefined();

    release();
    await deleting;
    expect(order).toEqual([`beforeDelete ${seeded.id}`, "removeWorkspace"]);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
  });

  it("runs beforeDelete before removing the worktree of a task that is not running", async () => {
    const failed = seedTask({ status: "failed", worktreePath: dir });
    const waiting = seedTask({ status: "needs-you", gate: "plan", worktreePath: dir });
    const order: string[] = [];
    const h = harness(() => ({}), {
      beforeDelete: async (taskId) => void order.push(`beforeDelete ${taskId}`),
      removeWorkspace: async (t) => void order.push(`removeWorkspace ${t.id}`),
    });
    await h.engine.delete(failed.id);
    await h.engine.delete(waiting.id);
    expect(order).toEqual([
      `beforeDelete ${failed.id}`,
      `removeWorkspace ${failed.id}`,
      `beforeDelete ${waiting.id}`,
      `removeWorkspace ${waiting.id}`,
    ]);
  });

  it("leaves beforeDelete alone when a running task is only stopped", async () => {
    const seeded = seedTask();
    const beforeDelete = vi.fn(async () => undefined);
    const h = harness((stage) => (stage === "inform" ? { hang: true, sessionId: "s" } : {}), {
      beforeDelete,
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("s"));

    expect(await h.engine.stop(seeded.id)).toMatchObject({ status: "interrupted" });
    expect(beforeDelete).not.toHaveBeenCalled();
  });

  it("deletes a task whose repo folder is gone without touching git", async () => {
    const seeded = seedTask({ worktreePath: "/gone/app.worktrees/t1" });
    const removeWorkspace = vi.fn(async () => undefined);
    const h = harness(() => ({}), { removeWorkspace, pathExists: () => false });
    await h.engine.delete(seeded.id);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
    expect(removeWorkspace).not.toHaveBeenCalled();
  });

  it("fails a task whose worktree is missing instead of running in it", async () => {
    const seeded = seedTask({ branch: "agent/x", worktreePath: "/gone/app.worktrees/t1" });
    const h = harness(() => ({}), { pathExists: (path) => path !== "/gone/app.worktrees/t1" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("failed");
    expect(task(seeded.id).error).toContain(
      "The task's worktree is missing at /gone/app.worktrees/t1",
    );
    expect(h.calls).toEqual([]);
  });

  it("keeps a backlog item that promoted a deleted task, unlinked", async () => {
    const seeded = seedTask();
    const item = r.backlogItems.insert({
      repoId: seeded.repoId,
      title: "Fix login",
      origin: { kind: "free-text" },
    });
    r.backlogItems.markPromoted(item.id, seeded.id);
    await harness().engine.delete(seeded.id);
    expect(r.backlogItems.get(item.id)).toMatchObject({ status: "promoted", taskId: null });
  });

  it("deletes a delivered task but keeps its branch", async () => {
    const done = seedTask({
      status: "failed",
      deliveryTargets: ["push-branch"],
      worktreePath: dir,
    });
    const partial = seedTask({ status: "needs-you", gate: "finish", worktreePath: dir });
    const run = r.runs.create(partial.id);
    const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
    r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, { action: "push-branch", detail: "x" });
    const squashed = seedTask({ status: "needs-you", gate: "finish", worktreePath: dir });
    const squashRun = r.runs.create(squashed.id);
    const squashStep = r.steps.create({ runId: squashRun.id, stage: "summarize", agentId: null });
    r.stepEvents.append(squashStep.id, DELIVERY_DONE_EVENT, { action: "squash", detail: "x" });

    const removeWorkspace = vi.fn<(t: Task, options?: { keepBranch?: boolean }) => Promise<void>>(
      async () => undefined,
    );
    const h = harness(() => ({}), { removeWorkspace });
    await h.engine.delete(done.id);
    await h.engine.delete(partial.id);
    await h.engine.delete(squashed.id);
    for (const id of [done.id, partial.id, squashed.id]) {
      expect(r.tasks.get(id)).toBeUndefined();
    }
    expect(removeWorkspace.mock.calls.map(([t, options]) => [t.id, options])).toEqual([
      [done.id, { keepBranch: true }],
      [partial.id, { keepBranch: true }],
      // A squash alone never left the machine.
      [squashed.id, undefined],
    ]);
  });
});

describe("repo rename lock", () => {
  it("keeps a task queued while its repo is renamed and runs it after", async () => {
    const seeded = seedTask();
    const renaming = createRepoRenameLocks();
    const prepared: string[] = [];
    const h = harness(() => ({}), {
      renaming,
      prepareWorkspace: async (t) => {
        prepared.push(t.id);
        return { branch: `agent/${t.id}`, worktreePath: dir };
      },
    });
    const release = renaming.hold(seeded.repoId);
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("queued");
    expect(h.engine.activeTaskIds()).toEqual([]);
    expect(prepared).toEqual([]);

    release();
    await vi.waitFor(() => expect(prepared).toEqual([seeded.id]));
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
  });

  it("refuses delivery and delete while the repo is renamed", async () => {
    const seeded = seedTask();
    const renaming = createRepoRenameLocks();
    const h = harness(() => ({}), { renaming });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    const release = renaming.hold(seeded.repoId);
    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);
    await expect(h.engine.delete(seeded.id)).rejects.toThrow(TaskStateError);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "finish",
      delivering: false,
    });
    expect(h.delivered).toEqual([]);
    release();
    await h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("done");
  });
});

describe("resume with guidance", () => {
  const GUIDANCE = "Use the v2 client";
  const guided = (prompt: string) => `${prompt}\n\n## Guidance from the user\n\n${GUIDANCE}`;
  const carries = (options: AgentRunOptions) => options.prompt.includes("Guidance from the user");

  it("adds the guidance to an interrupted step's resume prompt, and not to the next stage", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage) =>
      stage === "inform" && hang ? { hang: true, sessionId: "inform-1" } : {},
    );
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("inform-1"));
    await h.engine.stop(seeded.id);
    const callsBefore = h.calls.length;

    hang = false;
    h.engine.resume(seeded.id, GUIDANCE);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    const [resumed, ...later] = h.calls.slice(callsBefore);
    expect(resumed!.options).toMatchObject({
      resumeSessionId: "inform-1",
      prompt: guided(RESUME_PROMPT),
    });
    expect(later.length).toBeGreaterThan(0);
    expect(later.some((c) => carries(c.options))).toBe(false);
  });

  it("adds the guidance to a failed step's fresh prompt", async () => {
    const seeded = seedTask();
    let fail = true;
    const h = harness((stage) => (stage === "inform" && fail ? { fail: "model overloaded" } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("failed");

    fail = false;
    h.engine.resume(seeded.id, GUIDANCE);
    await settle(h.engine);
    const informs = h.calls.filter((c) => c.stage === "inform");
    expect(informs).toHaveLength(2);
    expect(carries(informs[0]!.options)).toBe(false);
    expect(informs[1]!.options.prompt).toBe(guided(informs[0]!.options.prompt));
    expect(informs[1]!.options.resumeSessionId).toBeUndefined();
  });

  it("keeps the guidance on the fresh start after a lost session", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage, options) => {
      if (stage === "inform" && hang) return { hang: true, sessionId: "inform-1" };
      if (options.resumeSessionId === "inform-1") return { missingSession: true };
      return {};
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("inform-1"));
    await h.engine.stop(seeded.id);
    const original = h.calls[0]!.options.prompt;
    const callsBefore = h.calls.length;

    hang = false;
    h.engine.resume(seeded.id, GUIDANCE);
    await settle(h.engine);
    const [resumed, fresh] = h.calls.slice(callsBefore);
    expect(resumed!.options.prompt).toBe(guided(RESUME_PROMPT));
    expect(fresh!.options.resumeSessionId).toBeUndefined();
    expect(fresh!.options.prompt).toBe(guided(original));
  });

  it("gives the guidance to every reviewer that failed, and none that succeeded", async () => {
    const reviewTask = () => seedTask({ mode: "review", origin: prOrigin() });

    // Both reviewers fail: both get it on resume.
    const both = reviewTask();
    let failing = true;
    const h = harness((stage) =>
      stage === "code-review" && failing ? { fail: "reviewer crashed" } : {},
    );
    h.engine.enqueue(both.id);
    await settle(h.engine);
    expect(task(both.id).status).toBe("failed");
    let callsBefore = h.calls.length;
    failing = false;
    h.engine.resume(both.id, GUIDANCE);
    await settle(h.engine);
    const retried = h.calls.slice(callsBefore).filter((c) => c.stage === "code-review");
    expect(retried).toHaveLength(2);
    expect(retried.every((c) => carries(c.options))).toBe(true);

    // One fails, one succeeds: only the failed one runs again, with the guidance.
    const one = reviewTask();
    let reviews = 0;
    const g = harness((stage) => {
      if (stage !== "code-review") return {};
      reviews += 1;
      return reviews === 2 ? { fail: "reviewer crashed" } : { structured: { findings: [] } };
    });
    g.engine.enqueue(one.id);
    await settle(g.engine);
    expect(task(one.id).status).toBe("failed");
    callsBefore = g.calls.length;
    g.engine.resume(one.id, GUIDANCE);
    await settle(g.engine);
    const rerun = g.calls.slice(callsBefore).filter((c) => c.stage === "code-review");
    expect(rerun).toHaveLength(1);
    expect(carries(rerun[0]!.options)).toBe(true);
  });

  it("leaves new steps of the resumed visit without the guidance", async () => {
    const defaults = createDefaultStages();
    const stages: StageHandlers = {
      ...defaults,
      inform: async (ctx) => {
        const result = await defaults.inform(ctx);
        await ctx.runAgent({ agentId: ctx.task.agents.planner!, prompt: "Side note", fresh: true });
        return result;
      },
    };
    const seeded = seedTask();
    let fail = true;
    const h = harness((stage) => (stage === "inform" && fail ? { fail: "model overloaded" } : {}), {
      stages,
    });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("failed");
    const callsBefore = h.calls.length;

    fail = false;
    h.engine.resume(seeded.id, GUIDANCE);
    await settle(h.engine);
    const [inform, side] = h.calls.slice(callsBefore);
    expect(carries(inform!.options)).toBe(true);
    expect(side!.options.prompt).toBe("Side note");
  });

  it("refuses guidance for a task stopped at a gate", async () => {
    const seeded = seedTask();
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.stop(seeded.id);
    expect(() => h.engine.resume(seeded.id, GUIDANCE)).toThrow(TaskStateError);
    expect(task(seeded.id)).toMatchObject({ status: "interrupted", gate: "plan-approval" });
    expect(h.engine.resume(seeded.id)).toMatchObject({ status: "needs-you" });
  });
});

describe("issue comments at plan approval", () => {
  const issueOrigin = {
    kind: "github-issue" as const,
    url: "https://github.com/acme/app/issues/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };
  const approve = (body = "Plan approved.") => ({
    gate: "plan-approval" as const,
    decision: "approve" as const,
    issueComment: { body },
  });
  /** Implement waits until the engine shuts down, so an approved task stays there. */
  const stages: StageHandlers = {
    ...createDefaultStages(),
    implement: (ctx) =>
      new Promise((_, reject) =>
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  };
  const deferred = () => {
    let release!: (value: { url: string }) => void;
    const promise = new Promise<{ url: string }>((resolve) => (release = resolve));
    return { promise, release };
  };
  const commentEvents = (taskId: string) =>
    stepsOf(taskId).flatMap((s) =>
      r.stepEvents.list(s.id).filter((e) => e.type === ISSUE_COMMENT_EVENT),
    );

  async function atPlanApproval(
    commentOnIssue: (task: Task, body: string) => Promise<{ url: string }>,
  ) {
    const seeded = seedTask({ origin: issueOrigin });
    const h = harness(() => ({}), { stages, commentOnIssue });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    return { h, id: seeded.id };
  }

  it("posts the comment, logs it on the plan review step and moves on without a new step", async () => {
    const commentOnIssue = vi.fn(async () => ({ url: ISSUE_COMMENT_URL }));
    const { h, id } = await atPlanApproval(commentOnIssue);
    const shape = () => stepsOf(id).map((s) => [s.id, s.stage, s.visit]);
    const before = shape();
    const review = stepsOf(id).findLast((s) => s.stage === "plan-review")!;

    const queued = await h.engine.respond(id, approve());

    expect(queued).toMatchObject({ status: "queued", gate: null, stage: "implement" });
    expect(commentOnIssue).toHaveBeenCalledOnce();
    expect(commentOnIssue).toHaveBeenCalledWith(expect.objectContaining({ id }), "Plan approved.");
    expect(shape()).toEqual(before);
    const logged = r.stepEvents.list(review.id).filter((e) => e.type === ISSUE_COMMENT_EVENT);
    expect(logged.map((e) => e.payload)).toEqual([{ url: ISSUE_COMMENT_URL, at: "plan-approval" }]);
    expect(commentEvents(id)).toHaveLength(1);
    expect(h.events).toContainEqual({ type: "step.event", payload: { event: logged[0] } });
    await vi.waitFor(() =>
      expect(task(id)).toMatchObject({ status: "running", stage: "implement" }),
    );
    await h.engine.shutdown();
  });

  it("leaves a task posting its comment alone when its pull request is merged", async () => {
    const post = deferred();
    const { h, id } = await atPlanApproval(() => post.promise);
    const run = r.runs.listByTask(id).at(-1)!;
    const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
    r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, {
      action: "open-pr",
      detail: "https://github.com/acme/app/pull/12",
    });

    const responding = h.engine.respond(id, approve());
    expect(await h.engine.finishMergedPullRequest("https://github.com/acme/app/pull/12")).toEqual(
      [],
    );
    expect(task(id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    post.release({ url: ISSUE_COMMENT_URL });
    await responding;
    await h.engine.shutdown();
  });

  it("leaves the task at its gate when the post fails, and a retry goes through", async () => {
    const commentOnIssue = vi
      .fn<(task: Task, body: string) => Promise<{ url: string }>>()
      .mockRejectedValueOnce(new Error("github.com: access denied"))
      .mockResolvedValue({ url: ISSUE_COMMENT_URL });
    const { h, id } = await atPlanApproval(commentOnIssue);

    await expect(h.engine.respond(id, approve())).rejects.toThrow("access denied");
    expect(task(id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      stage: "plan-review",
    });
    expect(commentEvents(id)).toEqual([]);
    expect(h.engine.queuedTaskIds()).toEqual([]);
    expect(h.engine.activeTaskIds()).toEqual([]);

    await expect(h.engine.respond(id, approve())).resolves.toMatchObject({
      status: "queued",
      stage: "implement",
    });
    expect(commentOnIssue).toHaveBeenCalledTimes(2);
    expect(commentEvents(id)).toHaveLength(1);
    await h.engine.shutdown();
  });

  it("posts once when the plan is approved twice at the same time", async () => {
    const post = deferred();
    const commentOnIssue = vi.fn(() => post.promise);
    const { h, id } = await atPlanApproval(commentOnIssue);

    const first = h.engine.respond(id, approve());
    await expect(h.engine.respond(id, approve())).rejects.toThrow(TaskStateError);
    await expect(
      h.engine.respond(id, { gate: "plan-approval", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);
    post.release({ url: ISSUE_COMMENT_URL });

    await expect(first).resolves.toMatchObject({ status: "queued", stage: "implement" });
    expect(commentOnIssue).toHaveBeenCalledOnce();
    expect(commentEvents(id)).toHaveLength(1);
    await h.engine.shutdown();
  });

  it("refuses delete while the comment posts, and allows it once settled", async () => {
    const post = deferred();
    const { h, id } = await atPlanApproval(() => post.promise);

    const answered = h.engine.respond(id, approve());
    await expect(h.engine.delete(id)).rejects.toThrow(TaskStateError);
    post.release({ url: ISSUE_COMMENT_URL });

    await expect(answered).resolves.toMatchObject({ status: "queued", stage: "implement" });
    expect(task(id)).toMatchObject({ stage: "implement" });
    await h.engine.delete(id);
    expect(r.tasks.get(id)).toBeUndefined();
  });

  it("leaves a task that is posting its comment alone on stop", async () => {
    const post = deferred();
    const { h, id } = await atPlanApproval(() => post.promise);

    const answered = h.engine.respond(id, approve());
    expect(await h.engine.stop(id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    post.release({ url: ISSUE_COMMENT_URL });

    await expect(answered).resolves.toMatchObject({ status: "queued", stage: "implement" });
    await h.engine.shutdown();
  });

  it("refuses an issue comment anywhere but a GitHub issue task's plan approval", async () => {
    const commentOnIssue = vi.fn(async () => ({ url: ISSUE_COMMENT_URL }));
    const h = harness(() => ({}), { commentOnIssue });
    const atGate = {
      status: "needs-you" as const,
      gate: "plan-approval" as const,
      stage: "plan-review" as const,
    };
    const freeText = seedTask(atGate);
    const issue = seedTask({ ...atGate, origin: issueOrigin });
    const finishing = seedTask({
      status: "needs-you",
      gate: "finish",
      stage: "summarize",
      origin: issueOrigin,
    });

    await expect(h.engine.respond(freeText.id, approve())).rejects.toThrow(
      InvalidGateResponseError,
    );
    await expect(h.engine.respond(issue.id, { ...approve(), decision: "revise" })).rejects.toThrow(
      InvalidGateResponseError,
    );
    await expect(h.engine.respond(finishing.id, { ...approve(), gate: "finish" })).rejects.toThrow(
      InvalidGateResponseError,
    );
    // No step to log it on: nothing is posted.
    await expect(h.engine.respond(issue.id, approve())).rejects.toThrow(TaskStateError);
    expect(commentOnIssue).not.toHaveBeenCalled();
    expect(task(issue.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
  });
});
