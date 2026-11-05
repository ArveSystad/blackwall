import type { Task, TaskCi } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CiFailure, CiWatcher } from "./ci.js";
import { TaskStateError } from "./engine.js";
import { DELIVERY_DONE_EVENT, type DeliveryContext } from "./delivery.js";
import type { PullRequestFeedback, PullRequestFeedbackThread } from "./pr-feedback.js";
import {
  closeEngineTest,
  openEngineTest,
  fakeArchiver,
  type Harness,
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

describe("CI", () => {
  const failedCi = (): TaskCi => ({
    state: "failed",
    sha: "abc1234def5678",
    host: "github.com",
    owner: "acme",
    repo: "app",
    checks: [
      {
        name: "test",
        kind: "check-run",
        id: 11,
        state: "failed",
        conclusion: "failure",
        url: "https://github.com/acme/app/runs/11",
      },
      {
        name: "lint",
        kind: "check-run",
        id: 12,
        state: "passed",
        conclusion: "success",
        url: null,
      },
    ],
    hint: null,
    startedAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:05:00.000Z",
    finishedAt: "2026-10-14T10:05:00.000Z",
  });

  function fakeCi(
    failureContext: (task: Task) => Promise<CiFailure[]> = async (t) =>
      t
        .ci!.checks.filter((c) => c.state === "failed")
        .map((check) => ({ check, log: "FAIL src/login.test.ts\nexpected 401" })),
  ) {
    return {
      watch: vi.fn<CiWatcher["watch"]>(async () => undefined),
      cancel: vi.fn<CiWatcher["cancel"]>(),
      failureContext: vi.fn(failureContext),
    };
  }

  const recording = async (ctx: DeliveryContext) => {
    for (const action of ctx.confirmation.actions) ctx.record({ action, detail: action });
  };

  async function atFinish(h: Harness, patch: Parameters<typeof seedTask>[0] = {}) {
    const seeded = seedTask(patch);
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    return seeded;
  }

  /** A task delivered with `actions`, whose CI then failed. */
  async function failedAfterPush(h: Harness, actions: ("push-branch" | "open-pr")[]) {
    const seeded = await atFinish(h);
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions },
    });
    r.tasks.update(seeded.id, { ci: failedCi() });
    return seeded;
  }

  it("watches CI after a delivery that pushed the branch, and not otherwise", async () => {
    const ci = fakeCi();
    const h = harness(() => ({}), { deliver: recording, ci });
    const pushed = await atFinish(h);
    await h.engine.respond(pushed.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["push-branch"] },
    });
    expect(ci.watch).toHaveBeenCalledExactlyOnceWith(pushed.id);

    const merged = await atFinish(h);
    await h.engine.respond(merged.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["merge-main"] },
    });
    expect(ci.watch).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a worktree archiving removed before creating the CI findings", async () => {
    const ci = fakeCi();
    const port = fakeArchiver();
    const h = harness(() => ({}), { deliver: recording, ci, archiveWorkspace: port });
    const seeded = await failedAfterPush(h, ["push-branch"]);
    h.engine.archive(seeded.id);
    await settle(h.engine);
    const findingsBefore = r.findings.listByTask(seeded.id).length;

    port.restore.mockRejectedValueOnce(new Error("The task's archived commit was not found"));
    await expect(h.engine.fixCi(seeded.id)).rejects.toThrow("archived commit was not found");
    expect(r.findings.listByTask(seeded.id)).toHaveLength(findingsBefore);
    expect(task(seeded.id)).toMatchObject({ status: "done", worktreeRemovedAt: expect.any(Date) });

    const queued = await h.engine.fixCi(seeded.id);
    expect(queued).toMatchObject({ status: "queued", worktreePath: dir, worktreeRemovedAt: null });
    expect(port.restore).toHaveBeenCalledTimes(2);
    expect(r.findings.listByTask(seeded.id).length).toBeGreaterThan(findingsBefore);
    await settle(h.engine);
  });

  it("fixes failed CI in a full review loop that stops at finish, and merges the targets", async () => {
    const ci = fakeCi();
    const h = harness(() => ({}), { deliver: recording, ci });
    const seeded = await failedAfterPush(h, ["push-branch", "open-pr"]);
    r.tasks.update(seeded.id, { archivedAt: new Date() });
    const runsBefore = r.runs.listByTask(seeded.id).length;
    const eventsBefore = h.events.length;

    const queued = await h.engine.fixCi(seeded.id);
    expect(queued).toMatchObject({ status: "queued", stage: "implement", archivedAt: null });
    expect(ci.cancel).toHaveBeenCalledWith(seeded.id);
    expect(ci.failureContext).toHaveBeenCalledOnce();

    const runs = r.runs.listByTask(seeded.id);
    expect(runs).toHaveLength(runsBefore + 1);
    const newRun = runs.at(-1)!.id;
    const [finding] = r.findings.listByTask(seeded.id).filter((f) => f.runId === newRun);
    expect(finding).toMatchObject({
      severity: "critical",
      status: "force-fix",
      stepId: null,
      reviewerAgentId: null,
      title: "CI failed: test",
      round: 0,
    });
    expect(finding!.explanation).toContain("https://github.com/acme/app/runs/11");
    expect(finding!.explanation).toContain("expected 401");

    await settle(h.engine);
    const implement = stepsOf(seeded.id).filter(
      (s) => s.runId === newRun && s.stage === "implement",
    );
    expect(implement.map((s) => s.round)).toEqual([1]);
    const lastImplement = h.calls.filter((c) => c.stage === "implement").at(-1)!;
    expect(lastImplement.options.prompt).toContain("CI failed: test");
    expect(lastImplement.options.prompt).toContain("expected 401");
    const stages = h.events
      .slice(eventsBefore)
      .flatMap((e) => (e.type === "task.upserted" ? [e.payload.task.stage] : []));
    for (const stage of ["implement", "checks", "code-review", "aggregate", "summarize"]) {
      expect(stages).toContain(stage);
    }
    expect(r.findings.get(finding!.id)!.status).toBe("fixed");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["push-branch"] },
    });
    expect(task(seeded.id)).toMatchObject({ status: "done" });
    expect(task(seeded.id).deliveryTargets.toSorted()).toEqual(["open-pr", "push-branch"]);
    expect(ci.watch).toHaveBeenCalledTimes(2);
  });

  it("refuses Fix CI unless a done work task's CI failed", async () => {
    const h = harness(() => ({}), { deliver: recording, ci: fakeCi() });
    const atGate = await atFinish(h);
    r.tasks.update(atGate.id, { ci: failedCi() });
    await expect(h.engine.fixCi(atGate.id)).rejects.toThrow(TaskStateError);

    const passed = await failedAfterPush(h, ["push-branch"]);
    r.tasks.update(passed.id, { ci: { ...failedCi(), state: "passed" } });
    await expect(h.engine.fixCi(passed.id)).rejects.toThrow(TaskStateError);

    const review = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/r" });
    r.tasks.update(review.id, { status: "done", ci: failedCi() });
    await expect(h.engine.fixCi(review.id)).rejects.toThrow(TaskStateError);
    expect(r.findings.listByTask(review.id)).toEqual([]);
  });

  it("refuses a second Fix CI while the first gathers its logs", async () => {
    let release: (failures: CiFailure[]) => void = () => undefined;
    const ci = fakeCi(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const h = harness(() => ({}), { deliver: recording, ci });
    const seeded = await failedAfterPush(h, ["push-branch"]);

    const first = h.engine.fixCi(seeded.id);
    await expect(h.engine.fixCi(seeded.id)).rejects.toThrow(/already fixing CI/);
    release([{ check: failedCi().checks[0]!, log: undefined }]);
    await expect(first).resolves.toMatchObject({ status: "queued" });
    await settle(h.engine);
  });

  describe("fetch comments and fix", () => {
    const PR = "https://github.com/o/r/pull/7";

    const prRecording = async (ctx: DeliveryContext) => {
      for (const action of ctx.confirmation.actions) {
        ctx.record({ action, detail: action === "open-pr" ? PR : action });
      }
    };

    const comment = (id: number, body: string, author = "reviewer") => ({
      url: `${PR}#discussion_r${id}`,
      author,
      body,
    });

    const thread = (patch: Partial<PullRequestFeedbackThread> = {}): PullRequestFeedbackThread => ({
      path: "src/login.ts",
      line: 4,
      startLine: 3,
      originalLine: 4,
      side: "RIGHT",
      outdated: false,
      url: `${PR}#discussion_r1`,
      diffHunk: "@@ -3,2 +3,2 @@\n-a == b\n+a === b",
      comments: [comment(1, "Use a constant-time compare")],
      ...patch,
    });

    /** A task delivered with `actions`, done. */
    async function deliveredWith(
      h: Harness,
      actions: ("push-branch" | "open-pr")[] = ["push-branch", "open-pr"],
    ) {
      const seeded = await atFinish(h);
      await h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions },
      });
      expect(task(seeded.id).status).toBe("done");
      return seeded;
    }

    /** Runs the queued fix round to the finish gate and pushes again. */
    async function pushAgain(h: Harness, taskId: string) {
      await settle(h.engine);
      expect(task(taskId)).toMatchObject({ status: "needs-you", gate: "finish" });
      await h.engine.respond(taskId, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["push-branch"] },
      });
      expect(task(taskId).status).toBe("done");
    }

    it("rebuilds a worktree archiving removed before creating the comment findings", async () => {
      const port = fakeArchiver();
      const prFeedback = vi.fn(async () => ({ threads: [thread()], conversation: [] }));
      const h = harness(() => ({}), {
        deliver: prRecording,
        ci: fakeCi(),
        prFeedback,
        archiveWorkspace: port,
      });
      const seeded = await deliveredWith(h);
      h.engine.archive(seeded.id);
      await settle(h.engine);
      const findingsBefore = r.findings.listByTask(seeded.id).length;

      port.restore.mockRejectedValueOnce(new Error("could not clear"));
      await expect(h.engine.fixPrComments(seeded.id)).rejects.toThrow("could not clear");
      expect(r.findings.listByTask(seeded.id)).toHaveLength(findingsBefore);

      const queued = await h.engine.fixPrComments(seeded.id);
      expect(queued).toMatchObject({
        status: "queued",
        worktreePath: dir,
        worktreeRemovedAt: null,
      });
      expect(r.findings.listByTask(seeded.id)).toHaveLength(findingsBefore + 1);
      await settle(h.engine);
    });

    it("turns new PR comments into force-fixed findings and runs a fix round to finish", async () => {
      const ci = fakeCi();
      const feedback: PullRequestFeedback = {
        threads: [thread()],
        conversation: [
          {
            url: `${PR}#pullrequestreview-9`,
            author: "lead",
            body: "Needs a test",
            reviewState: "CHANGES_REQUESTED",
          },
        ],
      };
      const prFeedback = vi.fn<(url: string) => Promise<PullRequestFeedback>>(async () => feedback);
      const h = harness(() => ({}), { deliver: prRecording, ci, prFeedback });
      const seeded = await deliveredWith(h);
      r.tasks.update(seeded.id, { archivedAt: new Date() });

      const queued = await h.engine.fixPrComments(seeded.id);
      expect(queued).toMatchObject({ status: "queued", stage: "implement", archivedAt: null });
      expect(prFeedback).toHaveBeenCalledExactlyOnceWith(PR);
      expect(ci.cancel).toHaveBeenCalledExactlyOnceWith(seeded.id);

      const runId = r.runs.listByTask(seeded.id).at(-1)!.id;
      const findings = r.findings.listByTask(seeded.id).filter((f) => f.runId === runId);
      expect(findings.map((f) => f.title)).toEqual([
        "PR comment: Use a constant-time compare",
        "PR conversation on #7",
      ]);
      expect(findings[0]).toMatchObject({
        severity: "high",
        status: "force-fix",
        file: "src/login.ts",
        lineStart: 3,
        lineEnd: 4,
      });

      await settle(h.engine);
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
      const lastImplement = h.calls.filter((c) => c.stage === "implement").at(-1)!;
      expect(lastImplement.options.prompt).toContain("Use a constant-time compare");
      expect(lastImplement.options.prompt).toContain("Needs a test");
    });

    it("fixes each comment once, and a reply on an outdated thread on its own", async () => {
      const ci = fakeCi();
      let feedback: PullRequestFeedback = { threads: [thread()], conversation: [] };
      const h = harness(() => ({}), { deliver: prRecording, ci, prFeedback: async () => feedback });
      const seeded = await deliveredWith(h);
      await h.engine.fixPrComments(seeded.id);
      await pushAgain(h, seeded.id);

      await expect(h.engine.fixPrComments(seeded.id)).rejects.toThrow(
        "No new comments on the pull request to fix",
      );
      expect(ci.cancel).toHaveBeenCalledTimes(1);

      feedback = {
        threads: [
          thread({
            line: null,
            startLine: null,
            outdated: true,
            comments: [comment(1, "Use a constant-time compare"), comment(2, "Still unsafe")],
          }),
        ],
        conversation: [],
      };
      await h.engine.fixPrComments(seeded.id);
      const runId = r.runs.listByTask(seeded.id).at(-1)!.id;
      const [reply, ...rest] = r.findings.listByTask(seeded.id).filter((f) => f.runId === runId);
      expect(rest).toEqual([]);
      expect(reply).toMatchObject({
        title: "PR comment: Still unsafe",
        file: "src/login.ts",
        lineStart: null,
        lineEnd: null,
      });
      expect(reply!.explanation).toContain(`Comment: ${PR}#discussion_r2`);
      expect(reply!.explanation).not.toContain(`Comment: ${PR}#discussion_r1`);
      expect(reply!.explanation).toContain("Outdated thread (originally line 4)");
      await settle(h.engine);
    });

    it("refuses unless a done work task opened a PR and a port can read it", async () => {
      const feedback: PullRequestFeedback = { threads: [thread()], conversation: [] };
      const h = harness(() => ({}), { deliver: prRecording, prFeedback: async () => feedback });

      const atGate = await atFinish(h);
      await expect(h.engine.fixPrComments(atGate.id)).rejects.toThrow(TaskStateError);

      const pushedOnly = await deliveredWith(h, ["push-branch"]);
      await expect(h.engine.fixPrComments(pushedOnly.id)).rejects.toThrow(
        /has not opened a pull request/,
      );

      const review = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/r" });
      r.tasks.update(review.id, { status: "done" });
      await expect(h.engine.fixPrComments(review.id)).rejects.toThrow(TaskStateError);

      const noPort = harness(() => ({}), { deliver: prRecording });
      const opened = await deliveredWith(noPort);
      await expect(noPort.engine.fixPrComments(opened.id)).rejects.toThrow(
        "Fetching PR comments is not available",
      );
      for (const t of [atGate, pushedOnly, review, opened]) {
        expect(r.findings.listByTask(t.id).filter((f) => f.title.startsWith("PR "))).toEqual([]);
      }
    });

    it("refuses a second fetch and Fix CI while the first fetch runs", async () => {
      let release: (feedback: PullRequestFeedback) => void = () => undefined;
      const prFeedback = () =>
        new Promise<PullRequestFeedback>((resolve) => {
          release = resolve;
        });
      const h = harness(() => ({}), { deliver: prRecording, ci: fakeCi(), prFeedback });
      const seeded = await deliveredWith(h);
      r.tasks.update(seeded.id, { ci: failedCi() });

      const first = h.engine.fixPrComments(seeded.id);
      await expect(h.engine.fixPrComments(seeded.id)).rejects.toThrow(/already fetching/);
      await expect(h.engine.fixCi(seeded.id)).rejects.toThrow(/already fetching/);
      release({ threads: [thread()], conversation: [] });
      await expect(first).resolves.toMatchObject({ status: "queued" });
      await settle(h.engine);
    });

    it("caps the findings at 20 and picks up the rest on the next call", async () => {
      const feedback: PullRequestFeedback = {
        threads: Array.from({ length: 25 }, (_, i) =>
          thread({ url: `${PR}#discussion_r${i + 1}`, comments: [comment(i + 1, `Comment ${i}`)] }),
        ),
        conversation: [],
      };
      const h = harness(() => ({}), { deliver: prRecording, prFeedback: async () => feedback });
      const seeded = await deliveredWith(h);
      const prFindings = () =>
        r.findings.listByTask(seeded.id).filter((f) => f.title.startsWith("PR comment:"));

      await h.engine.fixPrComments(seeded.id);
      expect(prFindings()).toHaveLength(20);
      await pushAgain(h, seeded.id);

      await h.engine.fixPrComments(seeded.id);
      expect(
        prFindings()
          .slice(20)
          .map((f) => f.title),
      ).toEqual([20, 21, 22, 23, 24].map((i) => `PR comment: Comment ${i}`));
      await settle(h.engine);
    });
  });

  describe("merged pull request", () => {
    const MERGED = "https://github.com/acme/app/pull/12";

    /** Records that a delivery of the task opened `url`, as a finish visit does. */
    function openedPr(taskId: string, url = "https://github.com/acme/app/pulls/12/") {
      const run = r.runs.listByTask(taskId).at(-1) ?? r.runs.create(taskId);
      const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
      r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, { action: "open-pr", detail: url });
    }

    it("finishes a task at its finish gate whose delivery opened the pull request", async () => {
      const ci = fakeCi();
      const h = harness(() => ({}), { ci });
      const seeded = await atFinish(h);
      openedPr(seeded.id);
      r.tasks.update(seeded.id, { ci: failedCi() });
      const eventsBefore = h.events.length;

      expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([seeded.id]);
      expect(task(seeded.id)).toMatchObject({
        status: "done",
        gate: null,
        error: null,
        ci: null,
        archivedAt: null,
      });
      expect(r.runs.listByTask(seeded.id).at(-1)).toMatchObject({ status: "succeeded" });
      expect(ci.cancel).toHaveBeenCalledWith(seeded.id);
      expect(h.events.slice(eventsBefore)).toContainEqual({
        type: "task.upserted",
        payload: { task: expect.objectContaining({ id: seeded.id, status: "done" }) },
      });
    });

    it("keeps an archived task archived", async () => {
      const h = harness();
      const seeded = await atFinish(h);
      openedPr(seeded.id);
      const archivedAt = new Date("2026-10-20T10:00:00Z");
      r.tasks.update(seeded.id, { archivedAt });

      expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([seeded.id]);
      expect(task(seeded.id)).toMatchObject({ status: "done", archivedAt });
    });

    it("stops a running work task on the pull request, then finishes it", async () => {
      const seeded = seedTask({
        origin: { ...prOrigin(), url: MERGED, number: 12 },
        mode: "work",
        branch: "feature/x",
      });
      const h = harness((stage) => (stage === "inform" ? { hang: true, sessionId: "s1" } : {}));
      h.engine.enqueue(seeded.id);
      await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("s1"));

      expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([seeded.id]);
      expect(h.calls[0]!.options.signal?.aborted).toBe(true);
      expect(task(seeded.id)).toMatchObject({ status: "done", gate: null, error: null });
      expect(h.engine.activeTaskIds()).toEqual([]);
    });

    it("leaves a task that is delivering alone", async () => {
      const h = harness();
      const seeded = await atFinish(h);
      openedPr(seeded.id);
      r.tasks.update(seeded.id, { delivering: true });

      expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([]);
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });

    it.each(["pending", "failed"] as const)(
      "stops watching a done task's %s CI and drops it, so Fix CI is gone",
      async (state) => {
        const ci = fakeCi();
        const h = harness(() => ({}), { ci });
        const seeded = await atFinish(h);
        openedPr(seeded.id);
        r.tasks.update(seeded.id, { status: "done", gate: null, ci: { ...failedCi(), state } });

        expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([seeded.id]);
        expect(ci.cancel).toHaveBeenCalledWith(seeded.id);
        expect(task(seeded.id)).toMatchObject({ status: "done", ci: null });
        await expect(h.engine.fixCi(seeded.id)).rejects.toThrow(TaskStateError);
      },
    );

    it("leaves review tasks and tasks on another pull request alone", async () => {
      const h = harness();
      const review = seedTask({
        mode: "review",
        origin: { ...prOrigin(), url: MERGED, number: 12 },
        branch: "feature/r",
      });
      r.tasks.update(review.id, { status: "needs-you", gate: "triage" });
      const other = await atFinish(h);
      openedPr(other.id, "https://github.com/acme/app/pull/13");

      expect(await h.engine.finishMergedPullRequest(MERGED)).toEqual([]);
      expect(task(review.id)).toMatchObject({ status: "needs-you", gate: "triage" });
      expect(task(other.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });
  });
});
