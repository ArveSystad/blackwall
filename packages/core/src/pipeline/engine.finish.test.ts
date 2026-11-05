import { MAX_FOLLOW_UPS, type ReviewFinding, type ServerEvent, type Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQuotaTracker } from "../agents/quota.js";
import { GitError } from "../git/service.js";
import { TaskStateError } from "./engine.js";
import type { FakeScript } from "./fake-adapter.js";
import {
  DELIVERY_CONFLICT_EVENT,
  DELIVERY_DONE_EVENT,
  DELIVERY_FAILED_EVENT,
  DeliveryError,
  createDeliverer,
} from "./delivery.js";
import { InvalidGateResponseError } from "./transitions.js";
import { FOLLOW_UPS_DROPPED_EVENT } from "./stages.js";
import {
  closeEngineTest,
  openEngineTest,
  createDefaultStages,
  highFinding,
  type Call,
  type Harness,
  harness,
  seedTask,
  task,
  settle,
  prOrigin,
  stepsOf,
  lastStep,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("summarize and finish", () => {
  const mediumFinding: ReviewFinding = {
    ...highFinding,
    severity: "medium",
    title: "Error message leaks the user name",
    lineStart: 12,
    lineEnd: 12,
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

  it("stores the summary with the open findings appended, the short summary and the squash message", async () => {
    const h = harness((stage, options) => {
      if (stage === "code-review") return { structured: { findings: [mediumFinding] } };
      if (stage === "summarize") {
        expect(options.prompt).toContain("Error message leaks the user name");
        expect(options.prompt).toContain("Do not mention ABC-1");
        expect(options.prompt).toContain("Also write `shortSummary`");
        return {
          structured: {
            summary: "Compared passwords strictly.",
            commitMessage: "Fix login",
            shortSummary: "Logins now reject wrong passwords.",
          },
        };
      }
      return {};
    });
    const seeded = await atFinish(h, {
      origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
    });
    const { summary, shortSummary, squashMessage } = task(seeded.id);
    expect(summary).toBe(
      "Compared passwords strictly.\n\n### Left open\n\n- **[medium] Error message leaks the user name** (`src/login.ts:12`): Type coercion lets an empty password through.",
    );
    expect(shortSummary).toBe("Logins now reject wrong passwords.");
    expect(squashMessage).toBe("chore: ABC-1 Fix login");
  });

  it("stores no short summary when it is missing, without losing the summary", async () => {
    const h = harness((stage) =>
      stage === "summarize"
        ? { structured: { summary: "Compared passwords strictly.", commitMessage: "Fix login" } }
        : {},
    );
    const seeded = await atFinish(h);
    expect(task(seeded.id)).toMatchObject({
      summary: "Compared passwords strictly.",
      shortSummary: null,
      squashMessage: "chore: Fix login",
    });
  });

  describe("follow-ups", () => {
    const followUp = (n: number) => ({ title: `Task ${n}`, description: `Do ${n}`, repoId: null });
    const summarizing = (followUps: unknown) => (stage: Call) =>
      stage === "summarize"
        ? { structured: { summary: "Analysed it.", commitMessage: "Plan the work", followUps } }
        : {};
    /** The dropped-follow-ups events on the summarizer's own (first) Summarize step. */
    const droppedEvents = (taskId: string) => {
      const agentId = task(taskId).agents.summarizer;
      const step = stepsOf(taskId).find((s) => s.stage === "summarize" && s.agentId === agentId)!;
      return r.stepEvents.list(step.id).filter((e) => e.type === FOLLOW_UPS_DROPPED_EVENT);
    };

    it("stores the proposed follow-ups, and lists the repos and rules in the prompts", async () => {
      const h = harness(summarizing([followUp(1)]));
      const seeded = await atFinish(h);
      expect(task(seeded.id).followUps).toEqual([followUp(1)]);
      expect(droppedEvents(seeded.id)).toEqual([]);
      for (const stage of ["inform", "summarize"] as const) {
        const prompt = h.calls.find((c) => c.stage === stage)!.options.prompt;
        expect(prompt).toContain(`\`${seeded.repoId}\`: app (this task's repo)`);
        expect(prompt).toContain("Each follow-up must be independent");
        expect(prompt).toContain("Do not split a sequence into separate follow-ups");
      }
      const inform = h.calls.find((c) => c.stage === "inform")!.options.prompt;
      expect(inform).toContain("Follow-up tasks are a valid deliverable");
      expect(inform).toContain("under a `### Follow-up tasks` heading, so the summary carries");
      const summarize = h.calls.find((c) => c.stage === "summarize")!.options.prompt;
      expect(summarize).toContain(
        "Return as `followUps` every task listed under the plan's `### Follow-up tasks` heading",
      );
      expect(summarize).toContain("a title of at most 120 characters");
      const implement = h.calls.find((c) => c.stage === "implement")!.options.prompt;
      expect(implement).toContain(
        "If the approved plan calls for no code changes, change nothing.",
      );
    });

    it("drops invalid follow-ups and keeps the limit, without losing the summary", async () => {
      const proposed = Array.from({ length: MAX_FOLLOW_UPS + 2 }, (_, i) => followUp(i + 1));
      proposed[1] = { title: "", description: "No title", repoId: null };
      const h = harness(summarizing(proposed));
      const seeded = await atFinish(h);
      expect(task(seeded.id)).toMatchObject({
        summary: "Analysed it.",
        squashMessage: "chore: Plan the work",
        followUps: [1, ...Array.from({ length: MAX_FOLLOW_UPS - 1 }, (_, i) => i + 3)].map(
          followUp,
        ),
      });
      const events = droppedEvents(seeded.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        notAList: false,
        received: MAX_FOLLOW_UPS + 2,
        kept: MAX_FOLLOW_UPS,
        dropped: [
          { index: 1, title: "", reason: "invalid", detail: expect.stringContaining("title: ") },
          {
            index: MAX_FOLLOW_UPS + 1,
            title: `Task ${MAX_FOLLOW_UPS + 2}`,
            reason: "over-limit",
            detail: null,
          },
        ],
      });
    });

    it("stores none when the follow-ups are not a list", async () => {
      const h = harness(summarizing("oops"));
      const seeded = await atFinish(h);
      expect(task(seeded.id)).toMatchObject({ summary: "Analysed it.", followUps: [] });
      const events = droppedEvents(seeded.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({ notAList: true, received: null, kept: 0, dropped: [] });
    });

    it.each([undefined, null])("logs nothing when the follow-ups are %s", async (followUps) => {
      const h = harness(summarizing(followUps));
      const seeded = await atFinish(h);
      expect(task(seeded.id).followUps).toEqual([]);
      expect(droppedEvents(seeded.id)).toEqual([]);
    });

    it("creates the confirmed follow-ups as waiting items, and none when kept local", async () => {
      const unused = async () => {
        throw new Error("Not expected");
      };
      const deliverer = createDeliverer({
        git: {
          isProtected: () => false,
          mergeBase: unused,
          commitsSince: unused,
          squash: unused,
          push: unused,
          // No remote: a free-text task is offered only the local merge.
          remoteUrl: async () => null,
          finishIntoMain: unused,
          branchExists: unused,
          renameBranch: unused,
        },
        repositories: r,
        ports: {
          parseRemote: () => undefined,
          openPullRequest: unused,
          commentOnPullRequest: unused,
          commentOnJiraIssue: unused,
          commentOnGitHubIssue: unused,
          reviewPullRequest: unused,
          githubConnectionId: () => null,
          requireIssueCredential: unused,
          createIssue: unused,
        },
      });
      const h = harness(summarizing([followUp(1), followUp(2)]), {
        deliver: (ctx) => deliverer.deliver(ctx),
      });

      const kept = await atFinish(h);
      await h.engine.respond(kept.id, { gate: "finish", decision: "approve" });
      expect(task(kept.id)).toMatchObject({ status: "done", deliveryTargets: [] });
      expect(r.backlogItems.list()).toEqual([]);

      const seeded = await atFinish(h);
      await h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["create-tasks"], followUpIndexes: [1] },
      });
      expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["create-tasks"] });
      expect(r.backlogItems.list()).toMatchObject([
        { title: "Task 2", freeText: "Do 2", status: "waiting", sourceTaskId: seeded.id },
      ]);
    });

    it("reaches the finish gate when the task changes no code", async () => {
      const git = {
        stagedDiff: vi.fn(async () => ""),
        commitAll: vi.fn(async () => undefined),
      };
      const reviewGit = {
        mergeBase: vi.fn(async () => "base"),
        headSha: vi.fn(async () => "base"),
        diff: vi.fn(async () => ""),
      };
      const h = harness(summarizing([followUp(1)]), {
        stages: createDefaultStages({ git, reviewGit }),
      });
      const seeded = await atFinish(h);
      expect(git.commitAll).not.toHaveBeenCalled();
      expect(task(seeded.id).followUps).toEqual([followUp(1)]);
    });
  });

  describe("memories", () => {
    const memory = (text: string, kind = "convention") => ({ kind, text, files: null });
    const summarizing =
      (memories: unknown, extra: (stage: Call) => FakeScript = () => ({})) =>
      (stage: Call) =>
        stage === "summarize"
          ? { structured: { summary: "Did it.", commitMessage: "Fix login", memories } }
          : extra(stage);
    const lowFinding: ReviewFinding = { ...highFinding, severity: "low", title: "Typo" };
    const summaries = (h: Harness) =>
      h.calls.filter((c) => c.stage === "summarize").map((c) => c.options.prompt);
    const REVIEW_LINE = "These notes are kept only if this pull request is merged into";

    /** Drives an already seeded task to the finish gate. */
    async function drive(h: Harness, seeded: Task) {
      h.engine.enqueue(seeded.id);
      await settle(h.engine);
      await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
      await settle(h.engine);
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    }

    /** Force-fixes the low finding at the finish gate, so Summarize runs again. */
    async function summarizeAgain(h: Harness, seeded: Task) {
      const [low] = r.findings.listByTask(seeded.id);
      h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
      await settle(h.engine);
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    }

    it("saves the proposed memories for the task's repo", async () => {
      const h = harness(summarizing([memory("Login uses argon2", "decision")]));
      const seeded = await atFinish(h);
      expect(r.memories.listByRepo(seeded.repoId)).toMatchObject([
        {
          kind: "decision",
          text: "Login uses argon2",
          sourceTaskId: seeded.id,
          awaitingMerge: false,
        },
      ]);
      expect(summaries(h)[0]).not.toContain(REVIEW_LINE);
      expect(h.events).toContainEqual({
        type: "memories.changed",
        payload: { repoId: seeded.repoId },
      });
    });

    it("keeps the summary and saves only the valid memories", async () => {
      const h = harness(
        summarizing([memory("x".repeat(501)), memory("Rumour", "gossip"), memory("Valid one")]),
      );
      const seeded = await atFinish(h);
      expect(task(seeded.id).summary).toBe("Did it.");
      expect(r.memories.listByRepo(seeded.repoId).map((m) => m.text)).toEqual(["Valid one"]);

      const bad = harness(summarizing("oops"));
      const other = await atFinish(bad);
      expect(task(other.id).summary).toBe("Did it.");
      expect(r.memories.listByRepo(other.repoId).map((m) => m.text)).toEqual(["Valid one"]);
    });

    it("replaces the task's own notes on another visit, keeping the user's edits", async () => {
      let reviews = 0;
      const h = harness(
        summarizing([memory("Login form posts JSON")], (stage) =>
          stage === "code-review"
            ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
            : {},
        ),
      );
      const seeded = await atFinish(h);
      const [own] = r.memories.listByRepo(seeded.repoId);
      const edited = r.memories.create({
        repoId: seeded.repoId,
        sourceTaskId: seeded.id,
        kind: "pitfall",
        text: "Login needs a CSRF token",
      });
      r.memories.update(edited.id, { text: "Login needs a CSRF token" }, { byUser: true });

      await summarizeAgain(h, seeded);
      expect(r.memories.listByRepo(seeded.repoId).map((m) => m.text)).toEqual([
        "Login form posts JSON",
        "Login needs a CSRF token",
      ]);
      expect(r.memories.listByRepo(seeded.repoId)[0]!.id).not.toBe(own!.id);
      // The second summary sees the user's note, not its own unedited one.
      const second = summaries(h)[1]!;
      expect(second).toContain("Login needs a CSRF token");
      expect(second).not.toContain("Login form posts JSON");
    });

    it("shows the repo's notes and the user's answers to the summarizer", async () => {
      const earlier = seedTask({ title: "Earlier" });
      r.memories.create({
        repoId: earlier.repoId,
        sourceTaskId: earlier.id,
        kind: "convention",
        text: "Login errors never name the user",
      });
      const seeded = seedTask();
      r.grillQuestions.create({
        taskId: seeded.id,
        stepId: null,
        question: "Should empty passwords be logged?",
        needsHuman: true,
        answer: "Never log passwords",
        answeredBy: "user",
        answeredAt: new Date(),
      });
      const h = harness((stage) =>
        stage === "summarize"
          ? { structured: { summary: "Did it.", commitMessage: "Fix login" } }
          : {},
      );
      await drive(h, seeded);
      const prompt = summaries(h)[0]!;
      expect(prompt).toContain("## What blackwall remembers about this repo");
      expect(prompt).toContain("- [convention] Login errors never name the user");
      expect(prompt).toContain("even in other words");
      expect(prompt).toContain(
        "## Answers the user gave\n\n- Should empty passwords be logged?\n  Answer (user): Never log passwords",
      );
      // Only the summarizer saves memories, and it proposed none.
      expect(r.memories.listByRepo(seeded.repoId).map((m) => m.text)).toEqual([
        "Login errors never name the user",
      ]);
    });

    it("holds a pull request task's memories until the pull request merges", async () => {
      const h = harness(summarizing([memory("Login lives in src/auth")]));
      const seeded = await atFinish(h, { origin: prOrigin(), mode: "work" });
      expect(r.memories.listByRepo(seeded.repoId)).toEqual([]);
      expect(r.memories.relevant(seeded.repoId, "login auth")).toEqual([]);
      expect(r.memories.tasksAwaitingMerge()).toEqual([seeded.id]);
      expect(summaries(h)[0]).toContain(`${REVIEW_LINE} \`main\``);
    });

    it("gives the relevant notes to Inform, Plan review and Implement", async () => {
      const seeded = seedTask();
      r.memories.create({
        repoId: seeded.repoId,
        kind: "pitfall",
        text: "Login tests need the fake clock",
      });
      let asked = 0;
      const h = harness((stage) => {
        if (stage === "plan-review" && asked++ === 0) {
          return { structured: { questions: [{ question: "Which hash?", needsHuman: false }] } };
        }
        if (stage === "plan-answers") {
          return { structured: { answers: [{ question: 1, answer: "argon2" }], plan: "p2" } };
        }
        return {};
      });
      await drive(h, seeded);
      for (const stage of ["inform", "plan-review", "plan-answers", "implement"] as const) {
        const prompt = h.calls.find((c) => c.stage === stage)!.options.prompt;
        expect(prompt, stage).toContain("## What blackwall remembers about this repo");
        expect(prompt, stage).toContain("- [pitfall] Login tests need the fake clock");
      }
    });
  });

  it("takes the summarizer's text when it misses the output contract", async () => {
    const h = harness((stage) => (stage === "summarize" ? { text: "Plain summary" } : {}));
    const seeded = await atFinish(h);
    expect(task(seeded.id)).toMatchObject({
      summary: "Plain summary",
      squashMessage: "chore: Fix login",
    });
  });

  it("delivers only the confirmed actions and records them", async () => {
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        for (const action of ctx.confirmation.actions) ctx.record({ action, detail: action });
      },
    });
    const seeded = await atFinish(h);
    // Approving without a confirmation sends nothing.
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["merge-main"] },
    });
    expect(h.deliveries[0]!.confirmation).toEqual({
      actions: ["merge-main"],
      squash: false,
      findingIds: [],
      followUpIndexes: [],
      followUpDestinations: {},
      approve: false,
    });
    expect(task(seeded.id)).toMatchObject({
      status: "done",
      gate: null,
      deliveryTargets: ["merge-main"],
    });
    const step = lastStep(seeded.id);
    expect(step).toMatchObject({ stage: "summarize", agentId: null, status: "succeeded" });
    expect(r.stepEvents.list(step.id).map((e) => e.payload)).toEqual([
      { action: "merge-main", detail: "merge-main" },
    ]);
  });

  it("saves the branch delivery renamed for a pull request", async () => {
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        ctx.renameBranch?.("feat/x");
      },
    });
    const seeded = await atFinish(h);
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["push-branch"] },
    });
    expect(task(seeded.id).branch).toBe("feat/x");
  });

  it("confirms nothing when the finish approval lists no actions", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    await h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    expect(h.deliveries[0]!.confirmation.actions).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: [] });
  });

  it("stores what to do when delivery fails with a git error", async () => {
    const h = harness(() => ({}), {
      deliver: async () => {
        throw new GitError(
          ["push", "--quiet", "origin"],
          "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com\n",
          128,
        );
      },
    });
    const seeded = await atFinish(h);
    await expect(
      h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["push-branch"] },
      }),
    ).rejects.toThrow(GitError);
    const message =
      "Could not reach the remote. Check the connection and retry. (fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com)";
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish", error: message });
    expect(lastStep(seeded.id)).toMatchObject({ status: "failed", error: message });
  });

  it("hands a retry the follow-ups a failed attempt created, and counts them as delivered", async () => {
    let attempt = 0;
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        attempt += 1;
        if (attempt === 1) {
          ctx.recordFollowUp({ index: 0, title: "A", destination: "github-issue", url: "u/1" });
          throw new DeliveryError("Could not create 1 follow-up issue");
        }
      },
    });
    const seeded = await atFinish(h);
    const delivery = { actions: ["create-tasks" as const], followUpIndexes: [0, 1] };
    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve", delivery }),
    ).rejects.toThrow("Could not create 1 follow-up issue");
    expect(h.deliveries[0]!.createdFollowUps).toEqual([]);

    // Nothing is confirmed this time, yet the issue created earlier still counts.
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: [] },
    });
    expect(h.deliveries[1]!.createdFollowUps).toEqual([
      { index: 0, title: "A", destination: "github-issue", url: "u/1" },
    ]);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["create-tasks"] });
  });

  it("keeps the task at finish when an action fails, and skips done ones on retry", async () => {
    let attempt = 0;
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        attempt += 1;
        if (!ctx.completed.includes("push-branch")) {
          ctx.record({ action: "push-branch", detail: "origin agent/x" });
        }
        if (attempt === 1) throw new DeliveryError("GitHub said no");
        ctx.record({ action: "open-pr", detail: "https://github.com/acme/app/pull/8" });
      },
    });
    const seeded = await atFinish(h);
    const delivery = { actions: ["push-branch", "open-pr"] as const };
    await expect(
      h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: [...delivery.actions] },
      }),
    ).rejects.toThrow("GitHub said no");
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "finish",
      error: "GitHub said no",
      delivering: false,
    });
    expect(lastStep(seeded.id)).toMatchObject({ status: "failed", error: "GitHub said no" });
    expect((await h.engine.deliveryPlan(seeded.id)).completed).toEqual(["push-branch"]);

    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: [...delivery.actions] },
    });
    expect(h.deliveries[1]!.completed).toEqual(["push-branch"]);
    expect(task(seeded.id)).toMatchObject({
      status: "done",
      error: null,
      deliveryTargets: ["push-branch", "open-pr"],
    });
  });

  it("counts actions an agent step logged during a delivery visit", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    const run = r.runs.listByTask(seeded.id).at(-1)!;
    const delivery = r.steps.create({
      runId: run.id,
      stage: "summarize",
      visit: 100,
      agentId: null,
    });
    r.stepEvents.append(delivery.id, DELIVERY_CONFLICT_EVENT, {
      branch: "agent/x",
      into: "main",
      files: ["src/login.ts"],
    });
    const resolver = r.steps.create({
      runId: run.id,
      stage: "summarize",
      visit: 100,
      agentId: seeded.agents.implementer!,
    });
    r.stepEvents.append(resolver.id, DELIVERY_DONE_EVENT, { action: "push-branch", detail: "x" });

    expect((await h.engine.deliveryPlan(seeded.id)).completed).toEqual(["push-branch"]);
  });

  it("treats a visit that only failed as a delivery visit, and keeps run order", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    const run = r.runs.listByTask(seeded.id).at(-1)!;
    const harnessStep = (visit: number) =>
      r.steps.create({ runId: run.id, stage: "summarize", visit, agentId: null });
    r.stepEvents.append(harnessStep(100).id, DELIVERY_DONE_EVENT, {
      action: "merge-main",
      detail: "x",
    });
    r.stepEvents.append(harnessStep(101).id, DELIVERY_FAILED_EVENT, { message: "no" });
    r.steps.create({
      runId: run.id,
      stage: "summarize",
      visit: 101,
      agentId: seeded.agents.implementer!,
    });
    r.stepEvents.append(harnessStep(102).id, DELIVERY_DONE_EVENT, {
      action: "push-branch",
      detail: "x",
    });

    expect((await h.engine.deliveryPlan(seeded.id)).completed).toEqual([
      "merge-main",
      "push-branch",
    ]);
  });

  const conflict = { branch: "agent/x", into: "main", files: ["src/login.ts"] };

  it("has the implementer resolve rebase conflicts as fresh steps of the delivery visit", async () => {
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        await ctx.resolveConflicts(conflict);
        await ctx.resolveConflicts({ ...conflict, files: ["src/other.ts"] });
        ctx.record({ action: "merge-main", detail: "abc (resolved conflicts in src/login.ts)" });
      },
    });
    const seeded = await atFinish(h);
    const before = stepsOf(seeded.id).length;
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: ["merge-main"] },
    });

    const resolvers = h.calls.filter((c) => c.stage === "resolve-conflicts");
    expect(resolvers).toHaveLength(2);
    expect(resolvers[0]!.options.prompt).toContain("- src/login.ts");
    expect(resolvers[0]!.options.prompt).toContain("Fix login");
    expect(resolvers[1]!.options.prompt).toContain("- src/other.ts");
    expect(resolvers[1]!.options.resumeSessionId).toBeUndefined();

    const [harnessStep, ...agentSteps] = stepsOf(seeded.id).slice(before);
    expect(harnessStep).toMatchObject({ stage: "summarize", agentId: null, status: "succeeded" });
    expect(agentSteps).toHaveLength(2);
    for (const step of agentSteps) {
      expect(step).toMatchObject({
        stage: "summarize",
        agentId: seeded.agents.implementer,
        visit: harnessStep!.visit,
        status: "succeeded",
      });
    }
    expect(r.stepEvents.list(harnessStep!.id).map((e) => e.type)).toEqual([
      DELIVERY_CONFLICT_EVENT,
      DELIVERY_CONFLICT_EVENT,
      DELIVERY_DONE_EVENT,
    ]);
    expect(r.stepEvents.list(harnessStep!.id)[0]!.payload).toEqual(conflict);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["merge-main"] });
  });

  it("keeps the task at finish when the resolver hits a usage limit", async () => {
    const quota = createQuotaTracker({ settings: r.settings });
    const h = harness((stage) => (stage === "resolve-conflicts" ? { rateLimit: {} } : {}), {
      quota,
      deliver: async (ctx) => {
        try {
          await ctx.resolveConflicts(conflict);
        } catch (error) {
          throw new DeliveryError(`the implementer could not resolve them: ${String(error)}`);
        }
      },
    });
    const seeded = await atFinish(h);
    await expect(
      h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["merge-main"] },
      }),
    ).rejects.toThrow(DeliveryError);

    const resolver = stepsOf(seeded.id).findLast((s) => s.agentId !== null)!;
    expect(resolver).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("usage limit"),
    });
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "finish",
      error: expect.stringContaining("could not resolve them"),
    });
  });

  it("keeps actions done before the resolver ran when a delivery is retried", async () => {
    let attempt = 0;
    const h = harness(() => ({}), {
      deliver: async (ctx) => {
        attempt += 1;
        if (attempt === 1) {
          ctx.record({ action: "squash", detail: "abc" });
          await ctx.resolveConflicts(conflict);
          throw new DeliveryError("main moved");
        }
      },
    });
    const seeded = await atFinish(h);
    const confirm = () =>
      h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["merge-main"], squash: true },
      });
    await expect(confirm()).rejects.toThrow("main moved");
    await confirm();
    expect(h.deliveries[1]!.completed).toEqual(["squash"]);
  });

  it("leaves the task untouched when the confirmation does not fit the plan", async () => {
    const h = harness(() => ({}), {
      deliver: async () => {
        throw new InvalidGateResponseError("open-pr is not a delivery action for this task");
      },
    });
    const seeded = await atFinish(h);
    const before = stepsOf(seeded.id).length;
    await expect(
      h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: ["open-pr"] },
      }),
    ).rejects.toThrow(InvalidGateResponseError);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish", error: null });
    expect(stepsOf(seeded.id)).toHaveLength(before);
  });

  it("refuses a second confirmation while the first is delivering", async () => {
    let release: () => void = () => undefined;
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const seeded = await atFinish(h);
    const first = h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", delivering: true });
    release();
    await first;
    expect(h.deliveries).toHaveLength(1);
    expect(task(seeded.id)).toMatchObject({ status: "done", delivering: false });
  });

  it("refuses delete while delivering, and allows it once delivered", async () => {
    let release: () => void = () => undefined;
    const removeWorkspace = vi.fn(async () => undefined);
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
      removeWorkspace,
    });
    const seeded = await atFinish(h);
    const first = h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    await expect(h.engine.delete(seeded.id)).rejects.toThrow(TaskStateError);
    expect(r.tasks.get(seeded.id)).toBeDefined();
    release();
    await first;
    await h.engine.delete(seeded.id);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
  });

  it("posts a Review PR task's selected findings at triage", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/x" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const [finding] = r.findings.listByTask(seeded.id);
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "approve",
      delivery: { actions: ["pr-review"], findingIds: [finding!.id] },
    });
    expect(h.deliveries[0]!.confirmation).toMatchObject({
      actions: ["pr-review"],
      findingIds: [finding!.id],
      approve: false,
    });
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["pr-review"] });
  });
});

describe("usage", () => {
  const call = (outputTokens: number, costUsd?: number) => ({
    inputTokens: 1,
    outputTokens,
    cacheReadTokens: 100,
    cacheWriteTokens: 10,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });
  const informStep = (taskId: string) => stepsOf(taskId).find((s) => s.stage === "inform")!;

  it("lifts streamed usage to the result's and takes its cost (Claude)", async () => {
    const seeded = seedTask();
    const h = harness((stage) =>
      stage === "inform"
        ? {
            usage: [call(3), call(3)],
            resultUsage: { ...call(500), cacheReadTokens: 300, costUsd: 0.05 },
          }
        : {},
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    const step = informStep(seeded.id);
    expect(step).toMatchObject({
      status: "succeeded",
      inputTokens: 2,
      outputTokens: 500,
      cacheReadTokens: 300,
      cacheWriteTokens: 20,
      costUsd: 0.05,
    });

    // The running totals go out as step.usage; only the success save is a step.upserted.
    const mine = (e: ServerEvent) =>
      (e.type === "step.usage" || e.type === "step.upserted") && e.payload.step.id === step.id;
    const published = h.events.filter(mine).map((e) => {
      const { type } = e;
      const s = (e as Extract<ServerEvent, { type: "step.usage" }>).payload.step;
      return [type, s.status, s.outputTokens, s.costUsd];
    });
    expect(published).toEqual([
      ["step.upserted", "running", 0, null],
      ["step.upserted", "running", 0, null],
      ["step.usage", "running", 3, null],
      ["step.usage", "running", 6, null],
      ["step.upserted", "succeeded", 500, 0.05],
    ]);
  });

  it("does not double a cost the usage events already carried (OpenCode)", async () => {
    const seeded = seedTask();
    const h = harness((stage) =>
      stage === "inform"
        ? {
            usage: [call(4, 0.01), call(6, 0.02)],
            resultUsage: { ...call(10), inputTokens: 2, cacheReadTokens: 200, costUsd: 0.03 },
          }
        : {},
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    const step = informStep(seeded.id);
    expect(step).toMatchObject({ inputTokens: 2, outputTokens: 10, cacheReadTokens: 200 });
    expect(step.costUsd).toBeCloseTo(0.03);
  });

  it("records no usage and no cost when the CLI reports none", async () => {
    const seeded = seedTask();
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informStep(seeded.id)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
    });
    expect(h.events.some((e) => e.type === "step.usage")).toBe(false);
  });

  it("keeps the streamed usage of a failed step", async () => {
    const seeded = seedTask();
    const h = harness((stage) =>
      stage === "inform" ? { usage: [call(3), call(4)], fail: "boom" } : {},
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informStep(seeded.id)).toMatchObject({
      status: "failed",
      outputTokens: 7,
      costUsd: null,
    });
  });

  it("adds a resumed step's usage to what it used before the interrupt", async () => {
    const seeded = seedTask();
    let hang = true;
    const h = harness((stage) => {
      if (stage === "inform" && hang) {
        return { hang: true, sessionId: "inform-1", usage: [call(3)] };
      }
      if (stage === "inform" || stage === "implement") {
        // A resume runs RESUME_PROMPT, which stageOf reads as implement.
        return { usage: [call(5)], resultUsage: { ...call(50), costUsd: 0.1 } };
      }
      return {};
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(lastStep(seeded.id)?.outputTokens).toBe(3));
    await h.engine.stop(seeded.id);
    expect(informStep(seeded.id)).toMatchObject({ status: "interrupted", outputTokens: 3 });

    hang = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(informStep(seeded.id)).toMatchObject({
      status: "succeeded",
      inputTokens: 2,
      outputTokens: 53,
      cacheReadTokens: 200,
      costUsd: 0.1,
    });
    expect(stepsOf(seeded.id).filter((s) => s.stage === "inform")).toHaveLength(1);
  });
});
