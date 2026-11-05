import {
  TASK_STOPPED_ERROR,
  type DeliveryAction,
  type DeliveryPlan,
  type Task,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localDelivery } from "./engine.js";
import type { DeliveryContext } from "./delivery.js";
import type { CheckOutcome, CheckRunner } from "./checks.js";
import { SETUP_SKIPPED_EVENT, SETUP_STARTED_EVENT } from "./setup.js";
import { NO_HUMAN_ANSWER } from "./stages.js";
import {
  closeEngineTest,
  openEngineTest,
  createDefaultStages,
  highFinding,
  type Harness,
  harness,
  agentService,
  seedTask,
  task,
  settle,
  prOrigin,
  stepsOf,
  dir,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("agent effort", () => {
  const plannerOf = (t: Task) => t.agents.planner as string;
  const informStep = (taskId: string) => stepsOf(taskId).find((s) => s.stage === "inform")!;
  const informCalls = (h: Harness) => h.calls.filter((c) => c.stage === "inform");

  it("passes the agent's effort for the CLI and records it on the step", async () => {
    const seeded = seedTask();
    agentService().update(plannerOf(seeded), { efforts: { claude: "low", copilot: "high" } });
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informCalls(h)[0]!.options.effort).toBe("low");
    expect(informStep(seeded.id)).toMatchObject({ cli: "claude", effort: "low" });
  });

  it("passes no effort and records null when the agent has none", async () => {
    const seeded = seedTask();
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informCalls(h)[0]!.options).not.toHaveProperty("effort");
    expect(informStep(seeded.id).effort).toBeNull();
  });

  it("records the effort a re-run step ran at", async () => {
    const seeded = seedTask();
    const agents = agentService();
    agents.update(plannerOf(seeded), { efforts: { claude: "low" } });
    let fail = true;
    const h = harness((stage) => (stage === "inform" && fail ? { fail: "model overloaded" } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informStep(seeded.id)).toMatchObject({ status: "failed", effort: "low" });

    fail = false;
    agents.update(plannerOf(seeded), { efforts: { claude: "high" } });
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(informCalls(h).map((c) => c.options.effort)).toEqual(["low", "high"]);
    expect(informStep(seeded.id)).toMatchObject({ status: "succeeded", effort: "high" });
  });

  it("passes and records no effort for a model the CLI takes none for", async () => {
    const seeded = seedTask({ cli: "copilot" });
    // Saved before the model rule existed: the pair would be rejected now.
    r.agents.update(plannerOf(seeded), {
      models: { copilot: "auto" },
      efforts: { copilot: "low" },
    });
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(informCalls(h)[0]!.options).toMatchObject({ model: "auto" });
    expect(informCalls(h)[0]!.options).not.toHaveProperty("effort");
    expect(informStep(seeded.id)).toMatchObject({ cli: "copilot", effort: null });
  });
});

describe("agent trust", () => {
  /** Each distinct trust the task's agent steps ran under, as `level,forced`. */
  const trustOf = (taskId: string) => [
    ...new Set(
      stepsOf(taskId)
        .filter((s) => s.agentId !== null)
        .map((s) => `${s.trust},${s.trustForced}`),
    ),
  ];
  const callTrust = (h: Harness) => h.calls.map((c) => c.options.permissions.trust.level);

  function trustedTask(
    agentTrust: "trusted" | "unrestricted",
    patch: Parameters<typeof seedTask>[0] = {},
  ) {
    const seeded = seedTask(patch);
    r.repos.update(seeded.repoId, { agentTrust, trustProjectMcp: true });
    return seeded;
  }

  it("runs a Review PR task Locked on a Trusted repo, and records why", async () => {
    const prBranchOwned = vi.fn(async () => true);
    const h = harness(() => ({}), { prBranchOwned });
    const seeded = trustedTask("trusted", { mode: "review", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(prBranchOwned).not.toHaveBeenCalled();
    expect(callTrust(h).length).toBeGreaterThan(0);
    expect(new Set(callTrust(h))).toEqual(new Set(["locked"]));
    expect(h.calls[0]!.options.permissions.trust).toMatchObject({
      forced: true,
      forcedReason: "review",
    });
    expect(trustOf(seeded.id)).toEqual(["locked,true"]);
  });

  it("runs a work PR on someone else's branch Locked", async () => {
    const h = harness(() => ({}), { prBranchOwned: async () => false });
    const seeded = trustedTask("trusted", { mode: "work", origin: prOrigin() });
    expect(task(seeded.id).prBranch).toBe("unchecked");
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).prBranch).toBe("foreign");
    expect(h.calls[0]!.options.permissions.trust).toMatchObject({
      level: "locked",
      forcedReason: "foreign-branch",
    });
    expect(trustOf(seeded.id)).toEqual(["locked,true"]);
  });

  it("keeps a work PR Locked when the ownership check fails", async () => {
    const h = harness(() => ({}), {
      prBranchOwned: async () => {
        throw new Error("rate limited");
      },
    });
    const seeded = trustedTask("trusted", { mode: "work", origin: prOrigin() });
    r.tasks.setPrBranch(seeded.id, "owned");
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).prBranch).toBe("unchecked");
    expect(h.calls[0]!.options.permissions.trust).toMatchObject({
      level: "locked",
      forcedReason: "unchecked-branch",
    });
  });

  it("runs the user's own work PR at the repo's level", async () => {
    const prBranchOwned = vi.fn(async () => true);
    const h = harness(() => ({}), { prBranchOwned });
    const seeded = trustedTask("trusted", { mode: "work", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(prBranchOwned).toHaveBeenCalledTimes(1);
    expect(task(seeded.id).prBranch).toBe("owned");
    expect(h.calls[0]!.options.permissions.trust).toEqual({
      level: "trusted",
      projectMcp: true,
      projectHooks: false,
      forced: false,
      forcedReason: null,
    });
    expect(trustOf(seeded.id)).toEqual(["trusted,false"]);
  });

  it("records Unrestricted on a free-text task's steps", async () => {
    const h = harness();
    const seeded = trustedTask("unrestricted");
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(h.calls[0]!.options.permissions).toMatchObject({ allow: [], deny: [] });
    expect(trustOf(seeded.id)).toEqual(["unrestricted,false"]);
  });

  it("never checks the branch on a Locked repo, and records Locked unforced", async () => {
    const prBranchOwned = vi.fn(async () => true);
    const h = harness(() => ({}), { prBranchOwned });
    const seeded = seedTask({ mode: "work", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(prBranchOwned).not.toHaveBeenCalled();
    expect(trustOf(seeded.id)).toEqual(["locked,false"]);
  });

  it("checks the branch again before the implementer resolves a delivery's conflicts", async () => {
    // One check per drive (Inform, then Implement onwards), then one before the resolver.
    const answers = [true, true, false];
    const prBranchOwned = vi.fn(async () => answers.shift() ?? false);
    const h = harness(
      (stage) => (stage === "code-review" ? { structured: { findings: [] } } : {}),
      {
        prBranchOwned,
        deliver: async (ctx) => {
          await ctx.resolveConflicts({ branch: "feature/x", into: "main", files: ["a.ts"] });
        },
      },
    );
    const seeded = trustedTask("trusted", {
      mode: "work",
      origin: prOrigin(),
      branch: "feature/x",
    });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "finish",
      prBranch: "owned",
    });
    await h.engine.respond(seeded.id, {
      gate: "finish",
      decision: "approve",
      delivery: { actions: [] },
    });
    const resolver = h.calls.find((c) => c.stage === "resolve-conflicts")!;
    expect(resolver.options.permissions.trust).toMatchObject({
      level: "locked",
      forcedReason: "foreign-branch",
    });
    expect(task(seeded.id).prBranch).toBe("foreign");
  });
});

describe("autonomous mode", () => {
  const merge: DeliveryAction = { kind: "merge-main", branch: "agent/x", into: "main" };
  const push: DeliveryAction = { kind: "push-branch", branch: "agent/x", remote: "origin" };
  const pr: DeliveryAction = {
    kind: "open-pr",
    host: "github.com",
    owner: "acme",
    repo: "app",
    head: "agent/x",
    base: "main",
    title: "Fix login",
    body: "",
  };
  const createTasks: DeliveryAction = {
    kind: "create-tasks",
    items: [1, 2].map((n) => ({
      title: `Task ${n}`,
      description: `Do ${n}`,
      repoId: "r1",
      repoName: "app",
      issueTarget: null,
      created: null,
    })),
  };
  const recording = async (ctx: DeliveryContext) => {
    for (const action of ctx.confirmation.actions) ctx.record({ action, detail: action });
  };

  it("runs a task to done, merging locally and creating follow-ups, never pushing", async () => {
    const h = harness(() => ({}), {
      autonomous: () => true,
      // A GitHub remote: the push and PR are offered next to the local merge.
      planActions: [merge, push, pr, createTasks],
      deliver: recording,
    });
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({
      status: "done",
      deliveryTargets: ["merge-main", "create-tasks"],
    });
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]!.confirmation).toMatchObject({
      actions: ["merge-main", "create-tasks"],
      squash: false,
      followUpIndexes: [0, 1],
    });
  });

  it("finishes with no actions when nothing local is offered", async () => {
    const h = harness(() => ({}), { autonomous: () => true, deliver: recording });
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: [] });
    expect(h.deliveries[0]!.confirmation.actions).toEqual([]);
  });

  it("passes a paused triage", async () => {
    let reviews = 0;
    const h = harness(
      (stage) =>
        stage === "code-review"
          ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
          : {},
      { autonomous: () => true, planActions: [merge], deliver: recording },
    );
    const seeded = seedTask({ triageMode: "pause" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["merge-main"] });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(2);
  });

  it("leaves an escalation to the user", async () => {
    const h = harness(
      (stage) => (stage === "code-review" ? { structured: { findings: [highFinding] } } : {}),
      { autonomous: () => true, planActions: [merge] },
    );
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
    expect(h.deliveries).toEqual([]);
  });

  it("leaves a finish that offers only a push and PR to the user", async () => {
    const h = harness(() => ({}), { autonomous: () => true, planActions: [push, pr] });
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.deliveries).toEqual([]);
  });

  it("changes nothing when the task is not autonomous", async () => {
    const h = harness(() => ({}), { autonomous: () => false, planActions: [merge] });
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
  });

  it("has the planner answer every question, the user's included", async () => {
    let grills = 0;
    const h = harness(
      (stage) => {
        if (stage === "plan-review" && grills++ === 0) {
          return {
            structured: {
              questions: [
                { question: "Lock after how many tries?", needsHuman: true },
                { question: "Which file?", needsHuman: false },
              ],
            },
          };
        }
        if (stage === "plan-answers") {
          return {
            structured: {
              answers: [
                { question: 1, answer: "Five" },
                { question: 2, answer: null },
              ],
              plan: "revised plan",
            },
          };
        }
        return {};
      },
      { autonomous: () => true },
    );
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id).status).toBe("done");
    expect(r.grillQuestions.listByTask(seeded.id)).toMatchObject([
      { needsHuman: true, answer: "Five", answeredBy: "agent" },
      { answer: NO_HUMAN_ANSWER, answeredBy: "agent" },
    ]);
    const answers = h.calls.find((c) => c.stage === "plan-answers")!.options.prompt;
    expect(answers).toContain("No human is in the loop");
  });

  it("moves on tasks already waiting at a gate when autonomy is switched on", async () => {
    let on = false;
    let grills = 0;
    const h = harness(
      (stage) => {
        if (stage === "plan-review" && grills++ === 0) {
          return { structured: { questions: [{ question: "Lock?", needsHuman: true }] } };
        }
        return {};
      },
      // One at a time: both tasks share the test's worktree.
      { autonomous: () => on, planActions: [merge], deliver: recording, maxPerRepo: 1 },
    );
    const asking = seedTask();
    h.engine.enqueue(asking.id);
    await settle(h.engine);
    expect(task(asking.id)).toMatchObject({ status: "needs-you", gate: "questions" });
    const approving = seedTask({ title: "Other", branch: "agent/other" });
    h.engine.enqueue(approving.id);
    await settle(h.engine);
    expect(task(approving.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });

    on = true;
    await h.engine.autopilotRepo(asking.repoId);
    await settle(h.engine);

    expect(r.grillQuestions.listByTask(asking.id)).toMatchObject([
      { answer: NO_HUMAN_ANSWER, answeredBy: "agent" },
    ]);
    expect(h.calls.filter((c) => c.stage === "plan-review")).toHaveLength(3);
    for (const id of [asking.id, approving.id]) {
      expect(task(id)).toMatchObject({ status: "done", deliveryTargets: ["merge-main"] });
    }
  });
});

describe("localDelivery", () => {
  it("keeps only the local merge and the follow-ups", () => {
    const plan = (actions: DeliveryAction[], completed: DeliveryPlan["completed"] = []) => ({
      actions,
      squash: null,
      completed,
    });
    const merge: DeliveryAction = { kind: "merge-main", branch: "b", into: "main" };
    const push: DeliveryAction = { kind: "push-branch", branch: "b", remote: "origin" };
    const comment: DeliveryAction = { kind: "issue-comment", url: "u", body: "b" };
    const follow: DeliveryAction = {
      kind: "create-tasks",
      items: [
        {
          title: "t",
          description: "d",
          repoId: "r",
          repoName: "app",
          issueTarget: null,
          created: null,
        },
      ],
    };
    expect(localDelivery(plan([merge, push, follow]))).toEqual({
      actions: ["merge-main", "create-tasks"],
      squash: false,
      followUpIndexes: [0],
    });
    // A retry skips what was done.
    expect(localDelivery(plan([merge, follow], ["merge-main"]))).toEqual({
      actions: ["create-tasks"],
      squash: false,
      followUpIndexes: [0],
    });
    // No commits leave no code route: only the follow-ups; the comment is never posted.
    expect(localDelivery(plan([comment, follow]))).toMatchObject({ actions: ["create-tasks"] });
    expect(localDelivery(plan([push, comment, follow]))).toBeNull();
  });

  it("sends only the follow-ups not created yet, all to the backlog", () => {
    const item = { description: "d", repoId: "r", repoName: "app", created: null };
    const issueTarget = { owner: "acme", repo: "app", connectionId: "c1" };
    const follow: DeliveryAction = {
      kind: "create-tasks",
      items: [
        { ...item, title: "a", issueTarget, created: { destination: "github-issue", url: "u" } },
        { ...item, title: "b", issueTarget },
        { ...item, title: "c", issueTarget: null, created: { destination: "backlog", url: null } },
      ],
    };
    const confirmation = localDelivery({ actions: [follow], squash: null, completed: [] });
    expect(confirmation).toEqual({
      actions: ["create-tasks"],
      squash: false,
      followUpIndexes: [1],
    });
    expect(confirmation).not.toHaveProperty("followUpDestinations");
    const allCreated: DeliveryAction = {
      kind: "create-tasks",
      items: [follow.items[0]!],
    };
    expect(localDelivery({ actions: [allCreated], squash: null, completed: [] })).toEqual({
      actions: [],
      squash: false,
      followUpIndexes: [],
    });
  });
});

describe("worktree setup", () => {
  const INSTALL = "pnpm install --frozen-lockfile";
  const passing: CheckOutcome = { exitCode: 0, output: "installed", timedOut: false };
  const failing: CheckOutcome = { exitCode: 1, output: "ERR_PNPM_NO_LOCKFILE", timedOut: false };
  /** A setup command that runs until the drive is aborted. */
  const untilAborted: CheckRunner = (_command, { signal }) =>
    new Promise((resolve) =>
      signal.addEventListener("abort", () =>
        resolve({ exitCode: null, output: "", timedOut: false }),
      ),
    );

  /** Setup with an in-memory stamp and a key over the commands and a mutable lockfile. */
  function fakeSetup(run: CheckRunner = async () => passing) {
    const stamps = new Map<string, string>();
    const lock = { value: "v1" };
    const key = (commands: readonly string[]) => JSON.stringify([commands, lock.value]);
    const setup = {
      key: async (_worktree: string, commands: readonly string[]) => key(commands),
      readStamp: async (worktree: string) => stamps.get(worktree) ?? null,
      writeStamp: async (worktree: string, value: string) => {
        stamps.set(worktree, value);
      },
      run: vi.fn<CheckRunner>(run),
    };
    return { setup, stamps, lock, key };
  }

  function seedSetupTask(
    setupCommands: string[] = [INSTALL],
    patch: Parameters<typeof seedTask>[0] = {},
  ) {
    const seeded = seedTask(patch);
    r.repos.update(seeded.repoId, { setupCommands });
    return seeded;
  }

  const setupSteps = (taskId: string) =>
    stepsOf(taskId).filter(
      (s) => s.agentId === null && r.stepEvents.list(s.id).some((e) => e.type.startsWith("setup.")),
    );
  const eventTypes = (stepId: string) => r.stepEvents.list(stepId).map((e) => e.type);
  const implementPrompts = (h: Harness) =>
    h.calls.filter((c) => c.stage === "implement").map((c) => c.options.prompt);

  it("sets up a fresh worktree during Inform and stamps it", async () => {
    const f = fakeSetup();
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(f.setup.run).toHaveBeenCalledTimes(1);
    expect(f.setup.run.mock.calls[0]![0]).toBe(INSTALL);
    expect(f.setup.run.mock.calls[0]![1].cwd).toBe(dir);
    expect(f.stamps.get(dir)).toBe(f.key([INSTALL]));
    const [step] = setupSteps(seeded.id);
    expect(step).toMatchObject({ stage: "inform", status: "succeeded", agentId: null });
    expect(eventTypes(step!.id)).toEqual([SETUP_STARTED_EVENT, "check.started", "check.finished"]);
    expect(r.stepEvents.list(step!.id)[0]!.payload).toEqual({
      key: f.key([INSTALL]),
      commands: [INSTALL],
    });
  });

  it("runs alongside the planner and holds the drive until it is done", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const f = fakeSetup(async () => {
      await released;
      return passing;
    });
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);

    await vi.waitFor(() =>
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" }),
    );
    expect(h.calls.map((c) => c.stage)).toContain("inform");
    expect(f.setup.run).toHaveBeenCalledTimes(1);
    // The drive keeps the repo's slot while setup runs at the gate.
    expect(h.engine.activeTaskIds()).toEqual([seeded.id]);

    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls.some((c) => c.stage === "implement")).toBe(false);

    release();
    await settle(h.engine);
    expect(implementPrompts(h)).toHaveLength(1);
    expect(f.setup.run).toHaveBeenCalledTimes(1);
    expect(setupSteps(seeded.id).map((s) => [s.stage, s.status])).toEqual([
      ["inform", "succeeded"],
      ["implement", "succeeded"],
    ]);
    expect(eventTypes(setupSteps(seeded.id)[1]!.id)).toEqual([SETUP_SKIPPED_EVENT]);
  });

  it("skips setup when the stamp matches the key", async () => {
    const f = fakeSetup();
    f.stamps.set(dir, f.key([INSTALL]));
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(f.setup.run).not.toHaveBeenCalled();
    const steps = setupSteps(seeded.id);
    expect(steps.map((s) => [s.stage, s.status])).toEqual([["inform", "succeeded"]]);
    expect(eventTypes(steps[0]!.id)).toEqual([SETUP_SKIPPED_EVENT]);
  });

  it("sets up again before Implement when a lockfile changed", async () => {
    const f = fakeSetup();
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    f.lock.value = "v2";
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(f.setup.run).toHaveBeenCalledTimes(2);
    expect(f.stamps.get(dir)).toBe(f.key([INSTALL]));
    expect(setupSteps(seeded.id).map((s) => [s.stage, s.status])).toEqual([
      ["inform", "succeeded"],
      ["implement", "succeeded"],
    ]);
  });

  it("sets up again when the repo's setup commands changed", async () => {
    const f = fakeSetup();
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    r.repos.update(seeded.repoId, { setupCommands: ["npm ci"] });
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(f.setup.run.mock.calls.map(([command]) => command)).toEqual([INSTALL, "npm ci"]);
    expect(f.stamps.get(dir)).toBe(f.key(["npm ci"]));
  });

  it("writes no stamp when setup fails and tries again on the next drive", async () => {
    const results = [failing, passing];
    const f = fakeSetup(async () => results.shift()!);
    const logs: string[] = [];
    const h = harness(() => ({}), { setup: f.setup, log: (m) => logs.push(m) });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(f.stamps.has(dir)).toBe(false);
    expect(setupSteps(seeded.id)[0]).toMatchObject({
      status: "failed",
      error: `\`${INSTALL}\` exited with code 1`,
    });
    expect(logs.some((m) => m.includes("worktree setup failed"))).toBe(true);

    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(f.setup.run).toHaveBeenCalledTimes(2);
    expect(f.stamps.get(dir)).toBe(f.key([INSTALL]));
    expect(implementPrompts(h)[0]).not.toContain("Worktree setup failed");
  });

  it("tries a failing setup once per drive and tells every Implement visit", async () => {
    const f = fakeSetup(async () => failing);
    const checkResults: CheckOutcome[] = [
      { exitCode: 1, output: "FAIL", timedOut: false },
      { exitCode: 0, output: "ok", timedOut: false },
    ];
    const runCheck = vi.fn<CheckRunner>(async () => checkResults.shift()!);
    const h = harness(() => ({}), {
      setup: f.setup,
      stages: createDefaultStages({ runCheck }),
    });
    const seeded = seedSetupTask();
    r.repos.update(seeded.repoId, { checkCommands: ["pnpm test"] });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(f.setup.run).toHaveBeenCalledTimes(1);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    // Once in the Inform drive, once in the Implement drive despite the check retry.
    expect(f.setup.run).toHaveBeenCalledTimes(2);
    const prompts = implementPrompts(h);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("## Worktree setup failed");
      expect(prompt).toContain(`\`${INSTALL}\` exited with code 1`);
      expect(prompt).toContain("ERR_PNPM_NO_LOCKFILE");
      expect(prompt).toContain("install what you need to work");
    }
    expect(stepsOf(seeded.id).some((s) => s.stage === "checks")).toBe(true);
    expect(runCheck).toHaveBeenCalledTimes(2);
    expect(f.stamps.has(dir)).toBe(false);
  });

  it("interrupts the background setup when the task is stopped", async () => {
    const f = fakeSetup(untilAborted);
    const h = harness((stage) => (stage === "inform" ? { hang: true } : {}), {
      setup: f.setup,
    });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() => expect(f.setup.run).toHaveBeenCalledTimes(1));

    expect(await h.engine.stop(seeded.id)).toMatchObject({
      status: "interrupted",
      error: TASK_STOPPED_ERROR,
    });
    expect(setupSteps(seeded.id).map((s) => s.status)).toEqual(["interrupted"]);
    expect(f.stamps.has(dir)).toBe(false);
    expect(h.engine.activeTaskIds()).toEqual([]);
  });

  it("finishes a task on a merged pull request once setup at its gate has stopped", async () => {
    const f = fakeSetup(untilAborted);
    const h = harness(() => ({}), { setup: f.setup });
    const merged = "https://github.com/acme/app/pull/7";
    const seeded = seedSetupTask([INSTALL], {
      origin: prOrigin(),
      mode: "work",
      branch: "feature/x",
    });
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() =>
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" }),
    );
    await vi.waitFor(() => expect(f.setup.run).toHaveBeenCalledTimes(1));

    expect(await h.engine.finishMergedPullRequest(merged)).toEqual([seeded.id]);
    expect(setupSteps(seeded.id).map((s) => s.status)).toEqual(["interrupted"]);
    expect(task(seeded.id)).toMatchObject({ status: "done", gate: null, error: null });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "done", gate: null });
  });

  it("stops setup a drive still runs at its gate", async () => {
    const f = fakeSetup(untilAborted);
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask();
    h.engine.enqueue(seeded.id);
    await vi.waitFor(() =>
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" }),
    );

    expect(await h.engine.stop(seeded.id)).toMatchObject({
      status: "interrupted",
      gate: "plan-approval",
      error: TASK_STOPPED_ERROR,
    });
    await settle(h.engine);
    expect(setupSteps(seeded.id).map((s) => s.status)).toEqual(["interrupted"]);
    expect(f.stamps.has(dir)).toBe(false);
    expect(h.engine.activeTaskIds()).toEqual([]);
  });

  it("does nothing for a repo without setup commands", async () => {
    const f = fakeSetup();
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask([]);
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(f.setup.run).not.toHaveBeenCalled();
    expect(stepsOf(seeded.id).filter((s) => s.agentId === null)).toEqual([]);
  });

  it("never sets up a Review PR task", async () => {
    const f = fakeSetup();
    const h = harness(() => ({}), { setup: f.setup });
    const seeded = seedSetupTask([INSTALL], { mode: "review", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id).status).toBe("needs-you");
    expect(f.setup.run).not.toHaveBeenCalled();
    expect(setupSteps(seeded.id)).toEqual([]);
  });

  it("sets an in-repo task up alongside the planner under Trusted, as nothing undoes it", async () => {
    const f = fakeSetup();
    const worktreeGuard = {
      snapshotWorktree: async () => ({ head: "h", index: "i", worktree: "w" }),
      restoreWorktree: async () => undefined,
    };
    const h = harness(() => ({}), { setup: f.setup, worktreeGuard });
    const seeded = seedSetupTask([INSTALL], { inRepo: true });
    r.repos.update(seeded.repoId, { agentTrust: "trusted" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).gate).toBe("plan-approval");
    expect(f.setup.run).toHaveBeenCalledTimes(1);
  });

  it("does not start Implement when stopped while waiting for setup under Trusted", async () => {
    const f = fakeSetup(untilAborted);
    const worktreeGuard = {
      snapshotWorktree: async () => ({ head: "h", index: "i", worktree: "w" }),
      restoreWorktree: async () => undefined,
    };
    const h = harness(() => ({}), { setup: f.setup, worktreeGuard });
    const seeded = seedSetupTask();
    r.repos.update(seeded.repoId, { agentTrust: "trusted" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    // The backstop would undo setup output during the planner's steps.
    expect(f.setup.run).not.toHaveBeenCalled();
    expect(setupSteps(seeded.id)).toEqual([]);

    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await vi.waitFor(() => expect(f.setup.run).toHaveBeenCalledTimes(1));
    expect(await h.engine.stop(seeded.id)).toMatchObject({
      status: "interrupted",
      error: TASK_STOPPED_ERROR,
    });

    expect(h.calls.some((c) => c.stage === "implement")).toBe(false);
    expect(setupSteps(seeded.id).map((s) => [s.stage, s.status])).toEqual([
      ["implement", "interrupted"],
    ]);
    expect(f.stamps.has(dir)).toBe(false);
  });
});
