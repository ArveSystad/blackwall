import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FIX_ROUNDS,
  MAX_GRILL_ROUNDS,
  TASK_STOPPED_ERROR,
  type AgentCli,
  type ReviewFinding,
  type ServerEvent,
  type Stage,
  type Task,
  type TaskCi,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../agents/adapters/types.js";
import { createQuotaTracker, type QuotaTracker } from "../agents/quota.js";
import { createAgentService } from "../agents/service.js";
import { DB_FILENAME, openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createGitService } from "../git/service.js";
import { ARTIFACTS_DIR } from "./artifacts.js";
import type { CiFailure, CiWatcher } from "./ci.js";
import {
  FindingNotFoundError,
  GrillQuestionNotFoundError,
  RESUME_PROMPT,
  TaskNotFoundError,
  TaskStateError,
  createPipelineEngine,
  type StageHandlers,
} from "./engine.js";
import { createFakeAdapter, type FakeScript } from "./fake-adapter.js";
import {
  DELIVERY_CONFLICT_EVENT,
  DELIVERY_DONE_EVENT,
  DeliveryError,
  ISSUE_COMMENT_EVENT,
  createDeliverer,
  postableFindings,
  type DeliveryContext,
} from "./delivery.js";
import type { CheckOutcome, CheckRunner } from "./checks.js";
import { InvalidGateResponseError } from "./transitions.js";
import { commitKey, commitMessage, createDefaultStages, diffCommentFinding } from "./stages.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-pipeline-"));
  open();
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function open() {
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
}

const highFinding: ReviewFinding = {
  severity: "high",
  tags: ["correctness"],
  file: "src/login.ts",
  lineStart: 3,
  lineEnd: 4,
  title: "Password compared with ==",
  explanation: "Type coercion lets an empty password through.",
  suggestedFix: "Use ===",
};

/**
 * Which stage an agent call belongs to, from its prompt. Plan review runs the
 * reviewers (`plan-review`), the planner's answers (`plan-answers`) and the
 * planner folding the user's answers into the plan (`plan-fold`); Checks runs
 * the summarizer's commit message (`commit`).
 */
type Call = Stage | "plan-answers" | "plan-fold" | "commit" | "resolve-conflicts";

function stageOf(options: AgentRunOptions): Call {
  if (options.prompt === RESUME_PROMPT) return "implement";
  if (options.prompt.includes("the rebase stopped on conflicts")) return "resolve-conflicts";
  if (options.prompt.includes("Write the git commit message")) return "commit";
  if (options.prompt.includes("Grill this plan")) return "plan-review";
  if (options.prompt.includes("Reviewers' questions")) return "plan-answers";
  if (options.prompt.includes("The user has answered")) return "plan-fold";
  if (options.prompt.includes("Summarize the changes")) return "summarize";
  if (options.jsonSchema) return "code-review";
  if (options.prompt.includes("write a concrete implementation plan")) return "inform";
  return "implement";
}

/**
 * Plan reviewers are satisfied, the planner keeps the plan and code reviewers
 * find nothing unless a script says otherwise.
 */
function withPlanDefaults(stage: Call, script: FakeScript): FakeScript {
  if (script.structured !== undefined || script.fail !== undefined || script.hang) return script;
  if (stage === "plan-review") return { ...script, structured: { questions: [] } };
  if (stage === "code-review") return { ...script, structured: { findings: [] } };
  if (stage === "plan-answers") {
    return { ...script, structured: { answers: [], plan: "revised plan" } };
  }
  return script;
}

const ISSUE_COMMENT_URL = "https://github.com/acme/app/issues/7#issuecomment-1";

interface Harness {
  engine: ReturnType<typeof createPipelineEngine>;
  calls: { stage: Call; cli: AgentCli; options: AgentRunOptions }[];
  events: ServerEvent[];
  delivered: string[];
  /** Delivery calls, with what the user confirmed. */
  deliveries: DeliveryContext[];
}

function harness(
  script: (stage: Call, options: AgentRunOptions) => FakeScript = () => ({}),
  {
    stages = createDefaultStages(),
    maxPerRepo = 3,
    deliver = async () => undefined,
    quota,
    removeWorkspace,
    commentOnIssue = async () => ({ url: ISSUE_COMMENT_URL }),
    pathExists,
    ci,
  }: {
    stages?: StageHandlers;
    maxPerRepo?: number;
    deliver?: (ctx: DeliveryContext) => Promise<void>;
    quota?: Pick<QuotaTracker, "report" | "succeeded">;
    removeWorkspace?: (task: Task) => Promise<void>;
    commentOnIssue?: (task: Task, body: string) => Promise<{ url: string }>;
    pathExists?: (path: string) => boolean;
    ci?: Pick<CiWatcher, "watch" | "cancel" | "failureContext">;
  } = {},
): Harness {
  const agents = agentService();
  const calls: Harness["calls"] = [];
  const run = (cli: AgentCli) => (options: AgentRunOptions) => {
    const stage = stageOf(options);
    calls.push({ stage, cli, options });
    return withPlanDefaults(stage, script(stage, options));
  };
  const events: ServerEvent[] = [];
  const delivered: string[] = [];
  const deliveries: DeliveryContext[] = [];
  const engine = createPipelineEngine({
    repositories: r,
    invocation: agents.invocation,
    adapters: {
      claude: createFakeAdapter("claude", run("claude")),
      copilot: createFakeAdapter("copilot", run("copilot")),
    },
    stages,
    prepareWorkspace: async (task) => ({
      branch: task.branch ?? `agent/${task.id}`,
      worktreePath: dir,
    }),
    delivery: {
      plan: async (_task, completed) => ({
        actions: [],
        squash: null,
        completed: completed.filter((c) => c !== "squash"),
      }),
      deliver: async (ctx) => {
        deliveries.push(ctx);
        await deliver(ctx);
        delivered.push(ctx.task.id);
      },
      commentOnIssue: (t, body) => commentOnIssue(t, body),
    },
    maxTasksPerRepo: () => maxPerRepo,
    ...(quota ? { quota } : {}),
    ...(removeWorkspace ? { removeWorkspace } : {}),
    ...(pathExists ? { pathExists } : {}),
    ...(ci ? { ci } : {}),
    publish: (event) => events.push(event),
    log: () => undefined,
  });
  return { engine, calls, events, delivered, deliveries };
}

function agentService() {
  return createAgentService({
    agents: r.agents,
    settings: r.settings,
    tags: r.tags,
    repos: r.repos,
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    transaction: r.transaction,
  });
}

function seedTask(patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {}): Task {
  const agents = agentService();
  agents.seed();
  const repo = r.repos.getByPath("/code/app") ?? r.repos.create({ path: "/code/app", name: "app" });
  return r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    freeText: "Login accepts empty passwords",
    agents: agents.resolveRoles(),
    ...patch,
  });
}

const task = (id: string) => r.tasks.get(id)!;

async function settle(engine: Harness["engine"]) {
  await engine.idle();
}

describe("pipeline engine", () => {
  it("creates a task from the form, publishes it and starts it", async () => {
    const seeded = seedTask();
    const h = harness((stage) => (stage === "inform" ? { text: "1. Compare with ===" } : {}));
    const created = h.engine.createTask({
      title: "Add dark mode",
      origin: { kind: "free-text" },
      mode: null,
      repoId: seeded.repoId,
      freeText: "Add dark mode",
      agents: seeded.agents,
      cli: "claude",
      agentClis: {},
      triageMode: "pause",
    });
    expect(created).toMatchObject({ status: "queued", triageMode: "pause", stage: null });
    expect(h.events[0]).toEqual({ type: "task.upserted", payload: { task: created } });
    await settle(h.engine);
    expect(task(created.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
  });

  it("drives a task through every stage, with an interrupt and resume", async () => {
    const seeded = seedTask();

    let reviews = 0;
    let grills = 0;
    const first = harness((stage) => {
      if (stage === "inform") return { text: "1. Compare with ===" };
      if (stage === "plan-review" && grills++ === 0) {
        // One question the repo answers, one only a human can.
        return {
          structured: {
            questions: [
              { question: "Should empty passwords be logged?", needsHuman: true },
              { question: "Where is the comparison?", needsHuman: false },
            ],
          },
        };
      }
      if (stage === "plan-answers") {
        return {
          structured: {
            answers: [{ question: 2, answer: "src/login.ts" }],
            plan: "1. Compare with === in src/login.ts",
          },
        };
      }
      if (stage === "plan-fold") return { text: "1. Compare with ===\n2. Do not log" };
      if (stage === "implement") return { hang: true, sessionId: "impl-session" };
      return {};
    });

    first.engine.enqueue(seeded.id);
    await settle(first.engine);
    // The planner answered what the repo could; the human question waits on the user.
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      stage: "plan-review",
      gate: "questions",
      plan: "1. Compare with === in src/login.ts",
      branch: `agent/${seeded.id}`,
      worktreePath: dir,
    });
    const [human, answered] = r.grillQuestions.listByTask(seeded.id);
    expect(human).toMatchObject({ needsHuman: true, answer: null });
    expect(answered).toMatchObject({
      needsHuman: false,
      answer: "src/login.ts",
      answeredBy: "agent",
    });
    expect(first.events.filter((e) => e.type === "grill.upserted")).toHaveLength(3);

    // The gate stays shut until every question is answered, and only by the user.
    await expect(
      first.engine.respond(seeded.id, { gate: "questions", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);
    await expect(
      first.engine.answerQuestion(seeded.id, answered!.id, { answer: "elsewhere" }),
    ).rejects.toThrow(TaskStateError);
    await expect(first.engine.answerQuestion(seeded.id, "nope", { answer: "No" })).rejects.toThrow(
      GrillQuestionNotFoundError,
    );

    // The last answer continues the task: the planner folds it in and the panel is satisfied.
    const reply = await first.engine.answerQuestion(seeded.id, human!.id, { answer: "No" });
    expect(reply.question).toMatchObject({ answer: "No", answeredBy: "user" });
    expect(reply.task).toMatchObject({ status: "queued", stage: "plan-review" });
    await settle(first.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      plan: "1. Compare with ===\n2. Do not log",
    });
    expect(first.calls.map((c) => c.stage)).toEqual([
      "inform",
      "plan-review",
      "plan-answers",
      "plan-fold",
      "plan-review",
    ]);
    const fold = first.calls[3]!.options.prompt;
    expect(fold).toContain("Should empty passwords be logged?");
    expect(fold).toContain("Answer (user): No");
    // The next grill round sees what was already answered.
    expect(first.calls[4]!.options.prompt).toContain("Answer (planner): src/login.ts");

    // Requested changes go back to the planner.
    await first.engine.respond(seeded.id, {
      gate: "plan-approval",
      decision: "revise",
      message: "Also lock the account after 5 tries",
    });
    await settle(first.engine);
    const informs = first.calls.filter((c) => c.stage === "inform");
    expect(informs).toHaveLength(2);
    expect(informs[1]!.options.prompt).toContain("Also lock the account after 5 tries");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });

    // Approve: the implementer starts and hangs; shut down mid-step.
    await first.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await vi.waitFor(() => {
      expect(first.calls.some((c) => c.stage === "implement")).toBe(true);
      expect(r.steps.get(lastStep(seeded.id).id)?.sessionId).toBe("impl-session");
    });
    expect(task(seeded.id)).toMatchObject({ status: "running", stage: "implement" });
    await first.engine.shutdown();

    const interrupted = lastStep(seeded.id);
    expect(interrupted).toMatchObject({
      stage: "implement",
      status: "interrupted",
      sessionId: "impl-session",
    });
    expect(task(seeded.id).status).toBe("interrupted");

    // Restart: a new process over the same database.
    opened.close();
    open();
    const second = harness((stage) => {
      if (stage === "code-review") {
        reviews++;
        return { structured: { findings: reviews === 1 ? [highFinding] : [] } };
      }
      return { text: stage === "summarize" ? "Fixed the comparison." : "done" };
    });
    second.engine.recover();
    expect(task(seeded.id).status).toBe("interrupted");

    second.engine.resume(seeded.id);
    await settle(second.engine);

    // The interrupted step continued its CLI session.
    const resumed = second.calls[0]!;
    expect(resumed.stage).toBe("implement");
    expect(resumed.options.resumeSessionId).toBe("impl-session");
    expect(resumed.options.prompt).toBe(RESUME_PROMPT);
    expect(r.steps.get(interrupted.id)).toMatchObject({ status: "succeeded" });

    // One blocking finding: one fix round, then a clean review, a summary and the finish gate.
    expect(second.calls.map((c) => c.stage)).toEqual([
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const fix = second.calls[3]!.options.prompt;
    expect(fix).toContain("Password compared with ==");
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      stage: "summarize",
      gate: "finish",
    });
    expect(r.findings.listByTask(seeded.id).map((f) => [f.round, f.status])).toEqual([
      [0, "fixed"],
    ]);

    const steps = r.steps.listByRun(r.runs.listByTask(seeded.id)[0]!.id);
    expect(steps.filter((s) => s.stage === "implement").map((s) => s.round)).toEqual([0, 1]);
    expect(steps.every((s) => s.status === "succeeded")).toBe(true);
    expect(r.runs.listByTask(seeded.id)).toHaveLength(1);

    await second.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    expect(second.delivered).toEqual([seeded.id]);
    // Archiving is manual: a done task stays listed.
    expect(task(seeded.id)).toMatchObject({ status: "done", gate: null, archivedAt: null });
    expect(r.runs.listByTask(seeded.id)[0]).toMatchObject({ status: "succeeded" });

    // Everything was broadcast as it happened.
    const types = new Set(second.events.map((e) => e.type));
    for (const type of [
      "task.upserted",
      "run.upserted",
      "step.upserted",
      "step.event",
      "finding.upserted",
    ]) {
      expect(types).toContain(type);
    }
    expect(r.stepEvents.list(interrupted.id).map((e) => e.type)).toEqual([
      "session",
      "error",
      "session",
      "message",
      "result",
    ]);
  });

  it("keeps finished panel steps when a resumed review continues", async () => {
    const seeded = seedTask({ mode: "review", origin: prOrigin() });
    let hung = false;
    const first = harness((stage, options) => {
      if (stage !== "code-review") return {};
      // The first reviewer finishes; the second hangs.
      if (!hung) {
        hung = true;
        return { structured: { findings: [highFinding] } };
      }
      return { hang: true, sessionId: options.resumeSessionId ?? "rev-2" };
    });
    first.engine.enqueue(seeded.id);
    await vi.waitFor(() => {
      const steps = stepsOf(seeded.id).filter((s) => s.stage === "code-review");
      expect(steps.map((s) => s.status).sort()).toEqual(["running", "succeeded"]);
      expect(steps.find((s) => s.status === "running")?.sessionId).toBe("rev-2");
    });
    await first.engine.shutdown();

    const second = harness(() => ({ structured: { findings: [] } }));
    second.engine.resume(seeded.id);
    await settle(second.engine);

    // Only the interrupted reviewer ran again, resuming its session.
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.options.resumeSessionId).toBe("rev-2");
    expect(r.findings.listByTask(seeded.id)).toHaveLength(1);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      stage: "aggregate",
      gate: "triage",
    });

    await second.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    expect(task(seeded.id).status).toBe("done");
    expect(second.delivered).toEqual([seeded.id]);
  });

  it("stops grilling at the round cap and still waits for plan approval", async () => {
    const seeded = seedTask();
    let asked = 0;
    const h = harness((stage) => {
      if (stage === "plan-review") {
        return { structured: { questions: [{ question: `Q${++asked}?`, needsHuman: false }] } };
      }
      if (stage === "plan-answers") {
        return { structured: { answers: [{ question: 1, answer: "A" }], plan: `plan v${asked}` } };
      }
      return {};
    });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(h.calls.filter((c) => c.stage === "plan-review")).toHaveLength(MAX_GRILL_ROUNDS);
    expect(h.calls.filter((c) => c.stage === "plan-answers")).toHaveLength(MAX_GRILL_ROUNDS);
    expect(h.calls.some((c) => c.stage === "implement")).toBe(false);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      plan: `plan v${MAX_GRILL_ROUNDS}`,
    });
    expect(r.grillQuestions.listByTask(seeded.id).map((q) => q.answeredBy)).toEqual(
      Array(MAX_GRILL_ROUNDS).fill("agent"),
    );

    // Only the user's approval starts the implementer.
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await vi.waitFor(() => expect(h.calls.some((c) => c.stage === "implement")).toBe(true));
    await h.engine.shutdown();
  });

  it("hands questions the planner cannot answer to the user", async () => {
    const seeded = seedTask();
    let grills = 0;
    const h = harness((stage) => {
      if (stage === "plan-review" && grills++ === 0) {
        return {
          structured: {
            questions: [{ question: "Lock after how many tries?", needsHuman: false }],
          },
        };
      }
      if (stage === "plan-answers") {
        return { structured: { answers: [{ question: 1, answer: null }], plan: "same plan" } };
      }
      return {};
    });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "questions" });
    const [q] = r.grillQuestions.listByTask(seeded.id);
    expect(q).toMatchObject({ needsHuman: true, answer: null });

    await h.engine.answerQuestion(seeded.id, q!.id, { answer: "5" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.calls.map((c) => c.stage)).toEqual([
      "inform",
      "plan-review",
      "plan-answers",
      "plan-fold",
      "plan-review",
    ]);
  });

  it("fails the task when a plan reviewer returns the wrong shape", async () => {
    const seeded = seedTask();
    const h = harness((stage) => (stage === "plan-review" ? { structured: { findings: [] } } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "failed",
      error: "A plan reviewer returned questions in the wrong shape",
    });
  });

  it("escalates after three fix rounds and finishes when the user accepts", async () => {
    const seeded = seedTask();
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
    const implementCalls = h.calls.filter((c) => c.stage === "implement");
    expect(implementCalls).toHaveLength(4); // the first pass plus three fix rounds

    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve" }),
    ).rejects.toThrow(TaskStateError);
    await h.engine.respond(seeded.id, { gate: "escalation", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("fails the task with the step's error and resumes it afresh", async () => {
    const seeded = seedTask();
    let fail = true;
    const h = harness((stage) => (stage === "inform" && fail ? { fail: "model overloaded" } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "failed", error: "model overloaded" });
    expect(lastStep(seeded.id)).toMatchObject({ status: "failed", error: "model overloaded" });

    fail = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "plan-approval",
      error: null,
    });
    // The failed step ran again from scratch, not via --resume.
    const informs = h.calls.filter((c) => c.stage === "inform");
    expect(informs).toHaveLength(2);
    expect(informs[1]!.options.resumeSessionId).toBeUndefined();
  });

  it("leaves a task stopped by a usage limit interrupted and resumes its session", async () => {
    const seeded = seedTask();
    const now = new Date("2026-10-09T12:00:00Z");
    const quota = createQuotaTracker({ settings: r.settings, clock: () => now });
    const resetsAt = "2026-10-09T15:00:00.000Z";
    let limited = true;
    const h = harness(
      (stage) =>
        stage === "inform" && limited ? { sessionId: "inform-1", rateLimit: { resetsAt } } : {},
      { quota },
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("usage limit"),
    });
    expect(lastStep(seeded.id)).toMatchObject({ status: "interrupted", sessionId: "inform-1" });
    expect(r.runs.listByTask(seeded.id).at(-1)?.status).toBe("interrupted");
    expect(quota.pausedUntil("claude")).toEqual(new Date(resetsAt));

    // Once the quota resets the released task resumes its CLI session.
    now.setTime(new Date(resetsAt).getTime() + 1);
    expect(quota.release()).toEqual([seeded.id]);
    limited = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.calls.some((c) => c.options.resumeSessionId === "inform-1")).toBe(true);
  });

  it("runs an agent on the CLI the task chose for it and records it on the step", async () => {
    const seeded = seedTask({ cli: "claude" });
    const planner = seeded.agents.planner!;
    r.tasks.update(seeded.id, { agentClis: { [planner]: "copilot" } });
    const h = harness();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.calls.filter((c) => c.stage === "inform").map((c) => c.cli)).toEqual(["copilot"]);
    expect(h.calls.filter((c) => c.stage === "plan-review").map((c) => c.cli)).toEqual(["claude"]);
    const steps = r.steps.listByRun(r.runs.listByTask(seeded.id)[0]!.id);
    expect(steps.find((s) => s.stage === "inform")?.cli).toBe("copilot");
    expect(steps.find((s) => s.stage === "plan-review")?.cli).toBe("claude");
  });

  it("charges a usage limit to the agent's CLI and resumes the step on that CLI", async () => {
    const seeded = seedTask({ cli: "copilot" });
    const planner = seeded.agents.planner!;
    r.tasks.update(seeded.id, { agentClis: { [planner]: "claude" } });
    const now = new Date("2026-10-09T12:00:00Z");
    const quota = createQuotaTracker({ settings: r.settings, clock: () => now });
    const resetsAt = "2026-10-09T15:00:00.000Z";
    let limited = true;
    const h = harness(
      (stage) =>
        stage === "inform" && limited ? { sessionId: "inform-1", rateLimit: { resetsAt } } : {},
      { quota },
    );
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(quota.pausedUntil("claude")).toEqual(new Date(resetsAt));
    expect(quota.pausedUntil("copilot")).toBeNull();
    expect(lastStep(seeded.id)).toMatchObject({ status: "interrupted", cli: "claude" });

    // The step's session belongs to Claude Code, even once the task's choice changes.
    r.tasks.update(seeded.id, { agentClis: {} });
    limited = false;
    h.engine.resume(seeded.id);
    await settle(h.engine);
    const resumed = h.calls.find((c) => c.options.resumeSessionId === "inform-1");
    expect(resumed?.cli).toBe("claude");
    expect(h.calls.filter((c) => c.stage === "plan-review").map((c) => c.cli)).toEqual(["copilot"]);
  });

  it("fails the task as before when no quota tracker is set", async () => {
    const seeded = seedTask();
    const h = harness((stage) => (stage === "inform" ? { rateLimit: {} } : {}));
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id).status).toBe("failed");
  });

  it("respects the per-repo cap and one task per branch, releasing slots at gates", async () => {
    const gates = new Map<string, () => void>();
    const stages: StageHandlers = {
      ...createDefaultStages(),
      inform: (ctx) =>
        new Promise<void>((resolve) => {
          gates.set(ctx.task.id, resolve);
        }),
      "plan-review": async () => ({ openQuestions: 0, satisfied: true }),
    };
    const h = harness(() => ({}), { stages, maxPerRepo: 2 });
    const a = seedTask({ branch: "feature/a" });
    const b = seedTask({ branch: "feature/a" });
    const c = seedTask({ branch: "feature/c" });
    const d = seedTask({ branch: "feature/d" });
    for (const t of [a, b, c, d]) h.engine.enqueue(t.id);

    // b waits for a's branch; c fills the second slot; d waits for a slot.
    await vi.waitFor(() => expect([...gates.keys()].sort()).toEqual([a.id, c.id].sort()));
    expect(h.engine.activeTaskIds().sort()).toEqual([a.id, c.id].sort());
    expect(h.engine.queuedTaskIds()).toEqual([b.id, d.id]);

    // a reaches its plan-approval gate and leaves its slot; b takes the branch.
    gates.get(a.id)!();
    await vi.waitFor(() => expect(gates.has(b.id)).toBe(true));
    expect(task(a.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(h.engine.queuedTaskIds()).toEqual([d.id]);

    gates.get(c.id)!();
    await vi.waitFor(() => expect(gates.has(d.id)).toBe(true));
    gates.get(b.id)!();
    gates.get(d.id)!();
    await settle(h.engine);
    expect([a, b, c, d].map((t) => task(t.id).gate)).toEqual(Array(4).fill("plan-approval"));
  });

  it("marks running tasks interrupted and schedules queued ones on recovery", async () => {
    const running = seedTask();
    const queued = seedTask();
    const run = r.runs.create(running.id);
    r.steps.create({ runId: run.id, stage: "inform", status: "running", sessionId: "s1" });
    r.tasks.update(running.id, { status: "running", stage: "inform" });

    const h = harness();
    h.engine.recover();
    await settle(h.engine);

    expect(task(running.id).status).toBe("interrupted");
    expect(lastStep(running.id).status).toBe("interrupted");
    expect(r.runs.get(run.id)?.status).toBe("interrupted");
    expect(task(queued.id)).toMatchObject({ status: "needs-you", gate: "plan-approval" });
    expect(() => h.engine.enqueue(running.id)).toThrow(TaskStateError);
  });

  it("clears a delivering flag a delivery cut short left on recovery", async () => {
    const seeded = seedTask();
    r.tasks.update(seeded.id, { status: "needs-you", gate: "finish", delivering: true });

    harness().engine.recover();

    expect(task(seeded.id)).toMatchObject({
      status: "needs-you",
      gate: "finish",
      delivering: false,
    });
  });

  it("adds the origin context to the Inform prompt once the worktree exists", async () => {
    const seeded = seedTask({
      origin: { kind: "jira-issue", key: "ABC-123", connectionId: null },
      branch: "feature/abc-123-export",
    });
    const originContext = vi.fn(async (t: Task) => {
      expect(t.worktreePath).toBe(dir);
      return "## Jira issue ABC-123: Export invoices";
    });
    const h = harness(() => ({}), { stages: createDefaultStages({ originContext }) });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);

    expect(originContext).toHaveBeenCalledTimes(1);
    const inform = h.calls.find((c) => c.stage === "inform")!;
    expect(inform.options.prompt).toContain("## Jira issue ABC-123: Export invoices");
  });
});

function prOrigin() {
  return {
    kind: "github-pr" as const,
    url: "https://github.com/acme/app/pull/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };
}

function stepsOf(taskId: string) {
  return r.runs.listByTask(taskId).flatMap((run) => r.steps.listByRun(run.id));
}

function lastStep(taskId: string) {
  return stepsOf(taskId).at(-1)!;
}

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
    const h = harness(() => ({}), { removeWorkspace });
    await h.engine.delete(seeded.id);
    expect(r.tasks.get(seeded.id)).toBeUndefined();
    expect(removeWorkspace).not.toHaveBeenCalled();
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

  it("refuses to delete a delivered task", async () => {
    const done = seedTask({ status: "done", deliveryTargets: ["push-branch"] });
    const partial = seedTask({ status: "needs-you", gate: "finish" });
    const run = r.runs.create(partial.id);
    const step = r.steps.create({ runId: run.id, stage: "summarize", agentId: null });
    r.stepEvents.append(step.id, DELIVERY_DONE_EVENT, { action: "push-branch", detail: "x" });
    const squashed = seedTask({ status: "needs-you", gate: "finish" });
    const squashRun = r.runs.create(squashed.id);
    const squashStep = r.steps.create({ runId: squashRun.id, stage: "summarize", agentId: null });
    r.stepEvents.append(squashStep.id, DELIVERY_DONE_EVENT, { action: "squash", detail: "x" });

    const h = harness();
    await expect(h.engine.delete(done.id)).rejects.toThrow(TaskStateError);
    await expect(h.engine.delete(partial.id)).rejects.toThrow(TaskStateError);
    expect(r.tasks.get(done.id)).toBeDefined();
    expect(r.tasks.get(partial.id)).toBeDefined();
    // A squash alone never left the machine.
    await h.engine.delete(squashed.id);
    expect(r.tasks.get(squashed.id)).toBeUndefined();
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

describe("archive", () => {
  it("archives a done task and publishes it", () => {
    const done = seedTask({ status: "done" });
    const h = harness();
    const archived = h.engine.archive(done.id);
    expect(archived).toMatchObject({ status: "done", archivedAt: expect.any(Date) });
    expect(task(done.id).archivedAt).toEqual(archived.archivedAt);
    expect(h.events).toEqual([{ type: "task.upserted", payload: { task: archived } }]);
  });

  it("refuses to archive a task that is not done", () => {
    const h = harness();
    for (const status of ["failed", "interrupted", "needs-you", "running"] as const) {
      const seeded = seedTask({ status });
      expect(() => h.engine.archive(seeded.id)).toThrow(TaskStateError);
      expect(task(seeded.id).archivedAt).toBeNull();
    }
    expect(() => h.engine.archive("nope")).toThrow(TaskNotFoundError);
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

describe("implement and checks", () => {
  const failing = (output: string): CheckOutcome => ({ exitCode: 1, output, timedOut: false });
  const passing: CheckOutcome = { exitCode: 0, output: "ok", timedOut: false };

  /** A task approved for implementation, in a repo with these check commands. */
  async function approved(
    h: Harness,
    checkCommands: string[],
    patch: Parameters<typeof seedTask>[0] = {},
  ) {
    const seeded = seedTask(patch);
    r.repos.update(seeded.repoId, { checkCommands });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    return seeded;
  }

  const afterApproval = (h: Harness) =>
    h.calls.slice(h.calls.findIndex((c) => c.stage === "implement")).map((c) => c.stage);

  const checkSteps = (taskId: string) =>
    stepsOf(taskId).filter((s) => s.stage === "checks" && s.agentId === null);

  const noFindings = (stage: Call): FakeScript =>
    stage === "code-review" ? { structured: { findings: [] } } : {};

  it("retries the implementer with the failing output before any reviewer runs", async () => {
    const results = [failing("FAIL src/login.test.ts\n  expected 401"), passing, passing];
    const runCheck = vi.fn<CheckRunner>(async () => results.shift()!);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, ["pnpm run test", "pnpm run lint"]);

    expect(afterApproval(h)).toEqual([
      "implement",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const retry = h.calls.filter((c) => c.stage === "implement")[1]!.options.prompt;
    expect(retry).toContain("`pnpm run test` exited with code 1");
    expect(retry).toContain("expected 401");
    expect(retry).toContain("Your changes fail the check above");
    // The first run stops at the failing command; the retry runs both.
    expect(runCheck.mock.calls.map(([command]) => command)).toEqual([
      "pnpm run test",
      "pnpm run test",
      "pnpm run lint",
    ]);
    expect(runCheck.mock.calls[0]![1].cwd).toBe(dir);
    expect(checkSteps(seeded.id).map((s) => [s.status, s.round])).toEqual([
      ["failed", 0],
      ["succeeded", 0],
    ]);
    expect(checkSteps(seeded.id)[0]!.error).toBe("`pnpm run test` exited with code 1");
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("turns a failure that survives the retry into a Critical correctness finding", async () => {
    let checks = 0;
    // Fails in round 0 (first pass and retry); passes once the fix round runs.
    const runCheck = vi.fn(async () => (++checks <= 2 ? failing("tsc: TS2322") : passing));
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, ["pnpm run typecheck"]);

    // The panel saw the change only after the implementer's retry.
    expect(afterApproval(h)).toEqual([
      "implement",
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const [finding] = r.findings.listByTask(seeded.id);
    expect(finding).toMatchObject({
      severity: "critical",
      tags: ["correctness"],
      title: "Check failed: pnpm run typecheck",
      reviewerAgentId: null,
      stepId: checkSteps(seeded.id)[1]!.id,
      round: 0,
      status: "fixed",
    });
    expect(finding!.explanation).toContain("still after 1 implementer retry");
    expect(finding!.explanation).toContain("tsc: TS2322");
    // The fix round got the finding, not the stale check output.
    const fix = h.calls.filter((c) => c.stage === "implement")[2]!.options.prompt;
    expect(fix).toContain("Check failed: pnpm run typecheck");
    expect(fix).not.toContain("Your changes fail the check above");
    expect(checkSteps(seeded.id).map((s) => [s.status, s.round])).toEqual([
      ["failed", 0],
      ["failed", 0],
      ["succeeded", 1],
    ]);
    expect(h.events.some((e) => e.type === "finding.upserted")).toBe(true);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("skips the checks when the repo has no check commands", async () => {
    const runCheck = vi.fn(async () => passing);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, []);
    expect(runCheck).not.toHaveBeenCalled();
    expect(checkSteps(seeded.id)).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ gate: "finish" });
  });

  it("commits each round with the summarizer's message, prefixed with the Jira key", async () => {
    const diffs = ["diff --git a/src/login.ts b/src/login.ts\n+if (a === b)"];
    const git = {
      stagedDiff: vi.fn<(worktree: string) => Promise<string>>(async () => diffs.shift() ?? ""),
      commitAll: vi.fn<(worktree: string, message: string) => Promise<string>>(
        async () => "abc123",
      ),
    };
    const h = harness(
      (stage) =>
        stage === "commit"
          ? { text: "```\nCompare passwords strictly\n\nUse ===.\n```" }
          : noFindings(stage),
      { stages: createDefaultStages({ git }) },
    );
    const seeded = await approved(h, [], {
      origin: { kind: "jira-issue", key: "ABC-123", connectionId: null },
      branch: "feature/abc-123-login",
    });

    expect(afterApproval(h)).toEqual([
      "implement",
      "commit",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const commitCall = h.calls.find((c) => c.stage === "commit")!;
    expect(commitCall.options.prompt).toContain("+if (a === b)");
    expect(commitCall.options.prompt).toContain("Do not mention ABC-123");
    expect(git.stagedDiff).toHaveBeenCalledWith(dir);
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    expect(git.commitAll).toHaveBeenCalledWith(
      dir,
      "ABC-123 Compare passwords strictly\n\nUse ===.",
    );
    // The summarizer's step belongs to Checks.
    const commitStep = stepsOf(seeded.id).find(
      (s) => s.stage === "checks" && s.agentId === seeded.agents.summarizer,
    );
    expect(commitStep).toMatchObject({ status: "succeeded", round: 0 });
  });

  it("never commits artifacts, even when the scratch .gitignore was deleted", async () => {
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    run("init", "--quiet", "-b", "main");
    run("config", "user.name", "Test");
    run("config", "user.email", "test@example.com");
    run("config", "commit.gpgsign", "false");
    writeFileSync(join(dir, ".gitignore"), `${DB_FILENAME}*\n`);
    run("add", "-A");
    run("commit", "--quiet", "-m", "initial");

    const h = harness(
      (stage) => {
        if (stage === "implement") {
          mkdirSync(join(dir, ARTIFACTS_DIR), { recursive: true });
          writeFileSync(join(dir, ARTIFACTS_DIR, "home.png"), "png");
          rmSync(join(dir, ".blackwall", ".gitignore"), { force: true });
          writeFileSync(join(dir, "login.ts"), "export {};\n");
        }
        return noFindings(stage);
      },
      { stages: createDefaultStages({ git: createGitService() }) },
    );
    await approved(h, []);

    const committed = run("show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(committed).toEqual(["login.ts"]);
    expect(run("ls-files")).not.toContain(".blackwall");
  });
});

describe("commit messages", () => {
  const withOrigin = (origin: unknown, branch: string | null = null) =>
    ({ origin, branch }) as unknown as Task;

  it("takes the Jira key from a Jira origin or a PR's head branch", () => {
    expect(commitKey(withOrigin({ kind: "jira-issue", key: "ABC-1" }))).toBe("ABC-1");
    expect(commitKey(withOrigin(prOrigin(), "feature/abc-12-login"))).toBe("ABC-12");
    expect(commitKey(withOrigin(prOrigin(), "bugfix"))).toBeUndefined();
    expect(commitKey(withOrigin({ kind: "free-text" }, "agent/abcdef12-3456"))).toBeUndefined();
  });

  it("unfences the message and prefixes the key once", () => {
    expect(commitMessage("```text\nAdd login\n```", "ABC-1")).toBe("ABC-1 Add login");
    expect(commitMessage("ABC-1 Add login", "ABC-1")).toBe("ABC-1 Add login");
    expect(commitMessage("  Add login \n", undefined)).toBe("Add login");
  });
});

describe("diff comment findings", () => {
  const comment = {
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: null,
    hunk: "@@ -1 +3 @@\n+x",
    body: "  Use a constant\nThe magic number repeats.  ",
  };

  it("titles the finding with the comment's first line and explains it with the hunk", () => {
    const seeded = seedTask();
    expect(diffCommentFinding(seeded, "run-1", 2, comment, "work")).toEqual({
      taskId: seeded.id,
      runId: "run-1",
      stepId: null,
      reviewerAgentId: null,
      severity: "high",
      tags: [],
      file: "src/a.ts",
      lineStart: 3,
      lineEnd: null,
      title: "Use a constant",
      explanation: "Use a constant\nThe magic number repeats.\n\n~~~~diff\n@@ -1 +3 @@\n+x\n~~~~",
      suggestedFix: null,
      status: "force-fix",
      round: 2,
    });
  });

  it("leaves a review task's comment open and explains it with the comment alone", () => {
    const seeded = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/x" });
    expect(diffCommentFinding(seeded, "run-1", 0, comment, "review")).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      severity: "high",
      title: "Use a constant",
      explanation: "Use a constant\nThe magic number repeats.",
      status: "open",
    });
  });

  it("cuts a long first line to 80 characters", () => {
    const seeded = seedTask();
    const titled = (body: string) =>
      diffCommentFinding(seeded, "run-1", 0, { ...comment, body }, "work").title;
    expect(titled("a".repeat(80))).toBe("a".repeat(80));
    const long = titled("word ".repeat(30));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("code review panel and triage", () => {
  const lowFinding: ReviewFinding = {
    severity: "low",
    tags: ["spelling"],
    file: "src/login.ts",
    lineStart: 10,
    lineEnd: 10,
    title: "Typo in error message",
    explanation: "Password is misspelled.",
    suggestedFix: "Fix the spelling",
  };

  async function approved(h: Harness, patch: Parameters<typeof seedTask>[0] = {}) {
    const seeded = seedTask(patch);
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    return seeded;
  }

  const afterApproval = (h: Harness) =>
    h.calls.slice(h.calls.findIndex((c) => c.stage === "implement")).map((c) => c.stage);

  it("merges the panel's duplicate findings into one", async () => {
    let review = 0;
    const h = harness((stage) => {
      if (stage !== "code-review") return {};
      review++;
      if (review === 1) return { structured: { findings: [highFinding] } };
      if (review === 2) {
        return {
          structured: {
            findings: [
              {
                ...highFinding,
                severity: "critical",
                tags: ["security"],
                title: "Loose password comparison with ==",
                explanation: "An empty string equals a missing password.",
                lineStart: 4,
                lineEnd: 6,
              },
              lowFinding,
            ],
          },
        };
      }
      return { structured: { findings: [] } };
    });
    const seeded = await approved(h);

    const findings = r.findings.listByTask(seeded.id);
    const [duplicate, primary, low] = findings;
    expect(findings.map((f) => f.status)).toEqual(["merged", "fixed", "open"]);
    expect(duplicate!.mergedIntoId).toBe(primary!.id);
    // The most severe report leads; the merge keeps every tag and the whole range.
    expect(primary).toMatchObject({
      title: "Loose password comparison with ==",
      severity: "critical",
      tags: ["security", "correctness"],
      lineStart: 3,
      lineEnd: 6,
    });
    expect(primary!.explanation).toContain("Also reported:\n- Password compared with ==");
    expect(low).toMatchObject({ severity: "low", status: "open" });
    // One fix round for the one merged blocker; the low finding goes to the summary.
    expect(afterApproval(h)).toEqual([
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const fix = h.calls.filter((c) => c.stage === "implement")[1]!.options.prompt;
    expect(fix).toContain("Loose password comparison");
    expect(fix).not.toContain("Typo in error message");
    expect(h.calls.at(-1)!.options.prompt).toContain("Typo in error message");
  });

  it("stops gating on a force-ignored blocker, even when a reviewer reports it again", async () => {
    let taskId = "";
    let implementCalls = 0;
    const h: Harness = harness((stage) => {
      if (stage === "code-review") return { structured: { findings: [highFinding] } };
      // The user ignores the blocker while the first fix round runs.
      if (stage === "implement" && ++implementCalls === 2) {
        const blocker = r.findings
          .listByTask(taskId)
          .find((f) => f.status === "force-fix" || f.status === "open");
        h.engine.overrideFinding(taskId, blocker!.id, { status: "force-ignore" });
      }
      return {};
    });
    const seeded = seedTask();
    taskId = seeded.id;
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    // The override survives the round, and the re-reports fold into it instead of gating.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(afterApproval(h)).toEqual([
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const findings = r.findings.listByTask(seeded.id);
    const ignored = findings.filter((f) => f.status === "force-ignore");
    expect(ignored).toHaveLength(1);
    expect(findings.filter((f) => f.status !== "force-ignore")).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ status: "merged", mergedIntoId: ignored[0]!.id }),
      ),
    );
    // The second round's reviewers were told not to report it again.
    const lastReview = h.calls.filter((c) => c.stage === "code-review").at(-1)!.options.prompt;
    expect(lastReview).toContain("Findings the user chose to ignore");
    expect(lastReview).toContain("Do not report these again");
    expect(h.calls.at(-1)!.options.prompt).toContain("Findings the user chose to ignore");
  });

  it("skips the fix round when the user ignores every blocker at a paused triage", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
        : {},
    );
    const seeded = await approved(h, { triageMode: "pause" });
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const [blocker] = r.findings.listByTask(seeded.id);
    const ignored = h.engine.overrideFinding(seeded.id, blocker!.id, { status: "force-ignore" });
    expect(ignored.status).toBe("force-ignore");
    expect(h.events).toContainEqual({ type: "finding.upserted", payload: { finding: ignored } });

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("fixes a force-fixed low finding in one more round from the final triage", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);
    // Low findings never gate: straight to the summary.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);

    // Force-fixing at the finish gate starts the fix round straight away.
    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    // A free slot picks the queued task up at once.
    expect(task(seeded.id)).toMatchObject({ status: "running", gate: null, stage: "implement" });

    await settle(h.engine);
    const fixes = h.calls.filter((c) => c.stage === "implement");
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.options.prompt).toContain("Typo in error message");
    expect(r.findings.get(low!.id)!.status).toBe("fixed");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    await h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    expect(h.delivered).toEqual([seeded.id]);
  });

  it("runs a fix round before finish for a finding force-fixed during Summarize", async () => {
    let reviews = 0;
    let summaries = 0;
    let taskId = "";
    const h: Harness = harness((stage) => {
      if (stage === "code-review") {
        return { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } };
      }
      // The user force-fixes the Low finding while the first summary is written.
      if (stage === "summarize" && ++summaries === 1) {
        const low = r.findings.listByTask(taskId).find((f) => f.status === "open");
        h.engine.overrideFinding(taskId, low!.id, { status: "force-fix" });
      }
      return {};
    });
    const seeded = seedTask();
    taskId = seeded.id;
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const [low] = r.findings.listByTask(seeded.id).filter((f) => f.title === lowFinding.title);
    expect(low!.status).toBe("fixed");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "summarize")).toHaveLength(2);
  });

  it("refuses to finish with a force-fixed finding not yet fixed", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    // Bypasses the engine, so no fix round starts.
    const [low] = r.findings.listByTask(seeded.id);
    r.findings.setStatus(low!.id, "force-fix");
    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve" }),
    ).rejects.toThrow(/force-fixed finding is not fixed yet/);
  });

  it("keeps waiting at the finish gate when a finding is force-ignored", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);

    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-ignore" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("keeps waiting at a paused triage when a finding is force-fixed", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = await approved(h, { triageMode: "pause" });
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const [blocker] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, blocker!.id, { status: "force-fix" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("queues one fix round when a finding is force-fixed twice at the finish gate", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);

    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    await settle(h.engine);
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(2);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("rejects overrides on unknown or merged findings", () => {
    const seeded = seedTask();
    const [target, duplicate] = r.findings.createMany(
      [highFinding, highFinding].map((f) => ({ ...f, taskId: seeded.id })),
    );
    r.findings.update(duplicate!.id, { status: "merged", mergedIntoId: target!.id });
    const h = harness();
    expect(() => h.engine.overrideFinding(seeded.id, "nope", { status: "force-fix" })).toThrow(
      FindingNotFoundError,
    );
    expect(() =>
      h.engine.overrideFinding(seeded.id, duplicate!.id, { status: "force-ignore" }),
    ).toThrow(TaskStateError);
    expect(() =>
      h.engine.overrideFinding(seeded.id, target!.id, { status: "open" as never }),
    ).toThrow(InvalidGateResponseError);
  });

  it("reviews the whole branch first, then only each fix round's diff", async () => {
    const heads = ["h0", "h1"];
    const reviewGit = {
      mergeBase: vi.fn(async (_worktree: string, ref: string) => {
        if (ref !== "main") throw new Error("unknown ref");
        return "base";
      }),
      headSha: vi.fn(async () => heads.shift() ?? "h1"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") =>
        from === "base" ? `+round 0 ${to}` : `+round 1 ${to}`,
      ),
    };
    let reviews = 0;
    const h = harness(
      (stage) =>
        stage === "code-review"
          ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
          : {},
      { stages: createDefaultStages({ reviewGit }) },
    );
    const seeded = await approved(h);

    const prompts = h.calls.filter((c) => c.stage === "code-review").map((c) => c.options.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("+round 0 h0");
    expect(prompts[0]).toContain("`git diff base h0`): everything this branch changes");
    expect(prompts[2]).toContain("+round 1 h1");
    expect(prompts[2]).toContain("`git diff h0 h1`): fix round 1");
    expect(reviewGit.mergeBase).toHaveBeenCalledTimes(1);
    // Each visit records its range on a harness step.
    const ranges = stepsOf(seeded.id)
      .filter((s) => s.stage === "code-review" && s.agentId === null)
      .map((s) => r.stepEvents.list(s.id).at(-1)!.payload);
    expect(ranges).toEqual([
      { from: "base", to: "h0" },
      { from: "h0", to: "h1" },
    ]);
  });

  it("reviews a stacked PR from its base branch, not from main", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async (_worktree: string, ref: string) =>
        ref === "origin/feature/a" ? "parent-tip" : "main-fork",
      ),
      headSha: vi.fn(async () => "h0"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") => `+${from} ${to}`),
    };
    const h = harness(() => ({}), { stages: createDefaultStages({ reviewGit }) });
    await approved(h, {
      origin: prOrigin(),
      mode: "work",
      branch: "feature/b",
      baseBranch: "feature/a",
    });

    const prompt = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(prompt).toContain("`git diff parent-tip h0`");
    expect(reviewGit.mergeBase).toHaveBeenCalledWith(expect.any(String), "origin/feature/a");
  });

  it("gives the code reviewers the task's details", async () => {
    const h = harness((stage) => (stage === "code-review" ? { structured: { findings: [] } } : {}));
    await approved(h);
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).toContain("## Details\n\nLogin accepts empty passwords");
  });

  it("gives the code reviewers the other PRs of the stack as context", async () => {
    const stackContext = vi.fn(async () => "1. #6: Below\n2. #7: This ← this PR");
    const h = harness(() => ({}), { stages: createDefaultStages({ stackContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).toContain("## Other pull requests in the stack\n\n1. #6: Below");
    expect(stackContext).toHaveBeenCalledTimes(1);
  });

  it("still reviews when the stack's context fails", async () => {
    const stackContext = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("github.com: rate limited");
    });
    const h = harness(() => ({}), { stages: createDefaultStages({ stackContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).not.toContain("Other pull requests in the stack");
    expect(stackContext).toHaveBeenCalled();
  });

  it("reviews a PR again at triage with the user's instruction", async () => {
    let reviews = 0;
    const h = harness((stage) => {
      if (stage !== "code-review") return {};
      reviews++;
      if (reviews === 1) return { structured: { findings: [highFinding] } };
      if (reviews === 2) return { structured: { findings: [lowFinding] } };
      // The re-review reports the first finding again.
      if (reviews === 3) return { structured: { findings: [highFinding] } };
      return { structured: { findings: [] } };
    });
    const seeded = seedTask({ mode: "review", origin: prOrigin(), freeText: "Focus on auth" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const first = h.calls.filter((c) => c.stage === "code-review");
    expect(first).toHaveLength(2);
    expect(first[0]!.options.prompt).toContain("Focus on auth");
    expect(first[0]!.options.prompt).not.toContain("Findings already reported");

    const [high, low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-ignore" });
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "revise",
      message: "Check the SQL",
    });
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const again = h.calls.filter((c) => c.stage === "code-review").slice(2);
    expect(again).toHaveLength(2);
    const prompt = again[0]!.options.prompt;
    expect(prompt).toContain("Focus on auth");
    expect(prompt).toContain("## Instructions from the user\n\nCheck the SQL");
    expect(prompt).toContain("## Findings already reported");
    expect(prompt).toContain(highFinding.title);
    // The ignored finding is listed only as ignored.
    expect(prompt.split(lowFinding.title)).toHaveLength(2);
    expect(prompt.indexOf(lowFinding.title)).toBeGreaterThan(
      prompt.indexOf("Findings the user chose to ignore"),
    );
    // The re-report folds into the first finding; the user's pick stays.
    const findings = r.findings.listByTask(seeded.id);
    expect(findings).toHaveLength(3);
    expect(r.findings.get(high!.id)!.status).toBe("open");
    expect(r.findings.get(low!.id)!.status).toBe("force-ignore");
    expect(findings[2]).toMatchObject({ status: "merged", mergedIntoId: high!.id });

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    expect(h.delivered).toEqual([seeded.id]);
  });

  it("reviews the whole PR again on a review task's re-review", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async () => "base"),
      headSha: vi.fn(async () => "h0"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") => `+${from}..${to}`),
    };
    const h = harness(
      (stage) => (stage === "code-review" ? { structured: { findings: [] } } : {}),
      { stages: createDefaultStages({ reviewGit }) },
    );
    const seeded = seedTask({ mode: "review", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "revise",
      message: "Look again",
    });
    await settle(h.engine);

    const prompts = h.calls.filter((c) => c.stage === "code-review").map((c) => c.options.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).toContain("+base..h0");
    expect(prompts[2]).toContain("`git diff base h0`): everything this branch changes");
    const ranges = stepsOf(seeded.id)
      .filter((s) => s.stage === "code-review" && s.agentId === null)
      .map((s) => r.stepEvents.list(s.id).at(-1)!.payload);
    expect(ranges).toEqual([
      { from: "base", to: "h0" },
      { from: "base", to: "h0" },
    ]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
  });

  it("skips the panel when the round changed nothing", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async () => "base"),
      headSha: vi.fn(async () => "base"),
      diff: vi.fn(async () => ""),
    };
    const h = harness(() => ({}), { stages: createDefaultStages({ reviewGit }) });
    const seeded = await approved(h);
    expect(afterApproval(h)).toEqual(["implement", "summarize"]);
    expect(task(seeded.id)).toMatchObject({ gate: "finish" });
  });
});

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
    expect(squashMessage).toBe("ABC-1 Fix login");
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
      squashMessage: "Fix login",
    });
  });

  describe("follow-ups", () => {
    const followUp = (n: number) => ({ title: `Task ${n}`, description: `Do ${n}`, repoId: null });
    const summarizing = (followUps: unknown) => (stage: Call) =>
      stage === "summarize"
        ? { structured: { summary: "Analysed it.", commitMessage: "Plan the work", followUps } }
        : {};

    it("stores the proposed follow-ups, and lists the repos and rules in the prompts", async () => {
      const h = harness(summarizing([followUp(1)]));
      const seeded = await atFinish(h);
      expect(task(seeded.id).followUps).toEqual([followUp(1)]);
      for (const stage of ["inform", "summarize"] as const) {
        const prompt = h.calls.find((c) => c.stage === stage)!.options.prompt;
        expect(prompt).toContain(`\`${seeded.repoId}\`: app (this task's repo)`);
        expect(prompt).toContain("Each follow-up must be independent");
        expect(prompt).toContain("Do not split a sequence into separate follow-ups");
      }
      const inform = h.calls.find((c) => c.stage === "inform")!.options.prompt;
      expect(inform).toContain("Follow-up tasks are a valid deliverable");
      const implement = h.calls.find((c) => c.stage === "implement")!.options.prompt;
      expect(implement).toContain(
        "If the approved plan calls for no code changes, change nothing.",
      );
    });

    it("drops invalid follow-ups and keeps five, without losing the summary", async () => {
      const proposed = [1, 2, 3, 4, 5, 6, 7].map(followUp);
      proposed[1] = { title: "", description: "No title", repoId: null };
      const h = harness(summarizing(proposed));
      const seeded = await atFinish(h);
      expect(task(seeded.id)).toMatchObject({
        summary: "Analysed it.",
        squashMessage: "Plan the work",
        followUps: [1, 3, 4, 5, 6].map(followUp),
      });
    });

    it("stores none when the follow-ups are not a list", async () => {
      const h = harness(summarizing("oops"));
      const seeded = await atFinish(h);
      expect(task(seeded.id)).toMatchObject({ summary: "Analysed it.", followUps: [] });
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
          remoteUrl: unused,
          finishIntoMain: unused,
        },
        repositories: r,
        ports: {
          parseRemote: () => undefined,
          openPullRequest: unused,
          commentOnPullRequest: unused,
          commentOnJiraIssue: unused,
          commentOnGitHubIssue: unused,
          reviewPullRequest: unused,
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

  it("takes the summarizer's text when it misses the output contract", async () => {
    const h = harness((stage) => (stage === "summarize" ? { text: "Plain summary" } : {}));
    const seeded = await atFinish(h);
    expect(task(seeded.id)).toMatchObject({ summary: "Plain summary", squashMessage: "Fix login" });
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

  it("confirms nothing when the finish approval lists no actions", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    await h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    expect(h.deliveries[0]!.confirmation.actions).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: [] });
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

describe("diff comments", () => {
  const comment = {
    file: "src/session.ts",
    lineStart: 12,
    lineEnd: 14,
    hunk: "@@ -10,3 +12,3 @@\n context\n-old\n+new",
    body: "Keep the old timeout\nIt is what the docs promise.",
  };

  async function atFinish(h: Harness) {
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    return seeded;
  }

  const implementCalls = (h: Harness) => h.calls.filter((c) => c.stage === "implement");

  it("turns comments at the finish gate into force-fixed findings and fixes them in a new round", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    const round = Math.max(...stepsOf(seeded.id).map((s) => s.round));

    const result = h.engine.commentOnDiff(seeded.id, {
      comments: [comment, { ...comment, file: "src/other.ts", body: "Rename this" }],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      status: "force-fix",
      severity: "high",
      file: "src/session.ts",
      lineStart: 12,
      lineEnd: 14,
      title: "Keep the old timeout",
      round,
    });
    expect(result.findings[0]!.explanation).toBe(
      `${comment.body}\n\n~~~~diff\n${comment.hunk}\n~~~~`,
    );
    for (const finding of result.findings) {
      expect(h.events).toContainEqual({ type: "finding.upserted", payload: { finding } });
    }
    // A free slot picks the queued task up at once.
    expect(result.task).toMatchObject({ status: "running", gate: null, stage: "implement" });

    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(2);
    expect(implementCalls(h)[1]!.options.prompt).toContain("Keep the old timeout");
    expect(implementCalls(h)[1]!.options.prompt).toContain("Rename this");
    expect(
      stepsOf(seeded.id)
        .filter((s) => s.stage === "implement")
        .at(-1)!.round,
    ).toBe(round + 1);
    expect(r.findings.listByTask(seeded.id).map((f) => f.status)).toEqual(["fixed", "fixed"]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("runs one more fix round from the escalation gate, past the round limit", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
    expect(implementCalls(h)).toHaveLength(MAX_FIX_ROUNDS + 1);

    const { findings, task: started } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(started).toMatchObject({ status: "running", gate: null, stage: "implement" });
    await settle(h.engine);

    expect(implementCalls(h)).toHaveLength(MAX_FIX_ROUNDS + 2);
    expect(implementCalls(h).at(-1)!.options.prompt).toContain("Keep the old timeout");
    expect(
      stepsOf(seeded.id)
        .filter((s) => s.stage === "implement")
        .at(-1)!.round,
    ).toBe(MAX_FIX_ROUNDS + 1);
    expect(r.findings.get(findings[0]!.id)!.status).toBe("fixed");
    // The reviewers still block, so the task escalates again.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
  });

  it("keeps a paused triage waiting and fixes the comments once triage is approved", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
        : {},
    );
    const seeded = seedTask({ triageMode: "pause" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const { findings, task: waiting } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(waiting).toMatchObject({ status: "needs-you", gate: "triage" });
    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(1);

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(2);
    expect(implementCalls(h)[1]!.options.prompt).toContain("Keep the old timeout");
    expect(r.findings.get(findings[0]!.id)!.status).toBe("fixed");
  });

  it("refuses comments outside the finish, triage and escalation gates, and outside review triage", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [] })).toThrow(
      InvalidGateResponseError,
    );
    expect(() =>
      h.engine.commentOnDiff(seeded.id, { comments: [{ ...comment, body: "  " }] }),
    ).toThrow(InvalidGateResponseError);

    r.tasks.update(seeded.id, { status: "running", gate: null });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(seeded.id, { status: "done", gate: null });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(seeded.id, { status: "needs-you", gate: "plan-approval" });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );

    const review = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/x" });
    r.tasks.update(review.id, { status: "needs-you", gate: "finish" });
    expect(() => h.engine.commentOnDiff(review.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(review.id, { status: "needs-you", gate: "escalation" });
    expect(() => h.engine.commentOnDiff(review.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    expect(() => h.engine.commentOnDiff("nope", { comments: [comment] })).toThrow(
      TaskNotFoundError,
    );
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });

  it("refuses comments while the task delivers", async () => {
    let release = () => undefined as void;
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const seeded = await atFinish(h);
    const delivering = h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));

    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    release();
    await delivering;
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });

  async function atReviewTriage(h: Harness) {
    const seeded = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/x" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    return seeded;
  }

  it("adds a review task's comments at triage as open findings to post, queuing nothing", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = await atReviewTriage(h);
    const calls = h.calls.length;

    const { findings, task: waiting } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      status: "open",
      severity: "high",
      title: "Keep the old timeout",
      explanation: comment.body,
    });
    expect(h.events).toContainEqual({
      type: "finding.upserted",
      payload: { finding: findings[0] },
    });
    expect(waiting).toMatchObject({ status: "needs-you", gate: "triage" });
    await settle(h.engine);
    expect(h.calls).toHaveLength(calls);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    expect(postableFindings(r.findings.listByTask(seeded.id)).map((f) => f.id)).toContain(
      findings[0]!.id,
    );
  });

  it("refuses a review task's comments while it delivers", async () => {
    let release = () => undefined as void;
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const seeded = await atReviewTriage(h);
    const delivering = h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));

    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    release();
    await delivering;
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });
});

describe("deleting findings", () => {
  function reviewAtTriage() {
    const seeded = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/x" });
    r.tasks.update(seeded.id, { status: "needs-you", gate: "triage" });
    const [target, duplicate, other] = r.findings.createMany(
      [highFinding, highFinding, highFinding].map((f) => ({ ...f, taskId: seeded.id })),
    );
    r.findings.update(duplicate!.id, { status: "merged", mergedIntoId: target!.id });
    return { seeded, target: target!, duplicate: duplicate!, other: other! };
  }

  it("deletes a finding with the duplicates merged into it, so it is no longer posted", () => {
    const h = harness();
    const { seeded, target, duplicate, other } = reviewAtTriage();

    const { deletedIds } = h.engine.deleteFinding(seeded.id, target.id);
    expect(deletedIds).toEqual([duplicate.id, target.id]);
    expect(h.events).toContainEqual({
      type: "finding.deleted",
      payload: { taskId: seeded.id, findingIds: [duplicate.id, target.id] },
    });
    expect(r.findings.listByTask(seeded.id).map((f) => f.id)).toEqual([other.id]);
    expect(postableFindings(r.findings.listByTask(seeded.id)).map((f) => f.id)).toEqual([other.id]);
  });

  it("deletes ignored findings and the user's own comments too", () => {
    const h = harness();
    const { seeded, other } = reviewAtTriage();
    r.findings.setStatus(other.id, "force-ignore");
    expect(h.engine.deleteFinding(seeded.id, other.id).deletedIds).toEqual([other.id]);
    const [mine] = r.findings.createMany([
      { ...highFinding, taskId: seeded.id, stepId: null, reviewerAgentId: null },
    ]);
    expect(h.engine.deleteFinding(seeded.id, mine!.id).deletedIds).toEqual([mine!.id]);
  });

  it("refuses merged, fixed and unknown findings, work tasks and review tasks off triage", () => {
    const h = harness();
    const { seeded, target, duplicate, other } = reviewAtTriage();

    expect(() => h.engine.deleteFinding(seeded.id, duplicate.id)).toThrow(TaskStateError);
    r.findings.setStatus(other.id, "fixed");
    expect(() => h.engine.deleteFinding(seeded.id, other.id)).toThrow(TaskStateError);
    expect(() => h.engine.deleteFinding(seeded.id, "nope")).toThrow(FindingNotFoundError);

    const elsewhere = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/y" });
    r.tasks.update(elsewhere.id, { status: "needs-you", gate: "triage" });
    expect(() => h.engine.deleteFinding(elsewhere.id, target.id)).toThrow(FindingNotFoundError);

    r.tasks.update(seeded.id, { status: "needs-you", gate: "finish" });
    expect(() => h.engine.deleteFinding(seeded.id, target.id)).toThrow(TaskStateError);

    const work = seedTask();
    r.tasks.update(work.id, { status: "needs-you", gate: "triage" });
    const [workFinding] = r.findings.createMany([{ ...highFinding, taskId: work.id }]);
    expect(() => h.engine.deleteFinding(work.id, workFinding!.id)).toThrow(TaskStateError);

    expect(r.findings.listByTask(seeded.id)).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "finding.deleted")).toEqual([]);
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
});
