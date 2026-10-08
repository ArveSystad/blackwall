import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_GRILL_ROUNDS,
  type ReviewFinding,
  type ServerEvent,
  type Stage,
  type Task,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../agents/adapters/types.js";
import { createAgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import {
  GrillQuestionNotFoundError,
  RESUME_PROMPT,
  TaskStateError,
  createPipelineEngine,
  type StageHandlers,
} from "./engine.js";
import { createFakeAdapter, type FakeScript } from "./fake-adapter.js";
import { createDefaultStages } from "./stages.js";

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
 * planner folding the user's answers into the plan (`plan-fold`).
 */
type Call = Stage | "plan-answers" | "plan-fold";

function stageOf(options: AgentRunOptions): Call {
  if (options.prompt === RESUME_PROMPT) return "implement";
  if (options.prompt.includes("Grill this plan")) return "plan-review";
  if (options.prompt.includes("Reviewers' questions")) return "plan-answers";
  if (options.prompt.includes("The user has answered")) return "plan-fold";
  if (options.jsonSchema) return "code-review";
  if (options.prompt.includes("write a concrete implementation plan")) return "inform";
  if (options.prompt.includes("Summarize")) return "summarize";
  return "implement";
}

/** Plan reviewers are satisfied and the planner keeps the plan unless a script says otherwise. */
function withPlanDefaults(stage: Call, script: FakeScript): FakeScript {
  if (script.structured !== undefined || script.fail !== undefined || script.hang) return script;
  if (stage === "plan-review") return { ...script, structured: { questions: [] } };
  if (stage === "plan-answers") {
    return { ...script, structured: { answers: [], plan: "revised plan" } };
  }
  return script;
}

interface Harness {
  engine: ReturnType<typeof createPipelineEngine>;
  calls: { stage: Call; options: AgentRunOptions }[];
  events: ServerEvent[];
  delivered: string[];
}

function harness(
  script: (stage: Call, options: AgentRunOptions) => FakeScript = () => ({}),
  { stages = createDefaultStages(), maxPerRepo = 3 } = {},
): Harness {
  const agents = createAgentService({ agents: r.agents, settings: r.settings, tags: r.tags });
  const calls: Harness["calls"] = [];
  const run = (options: AgentRunOptions) => {
    const stage = stageOf(options);
    calls.push({ stage, options });
    return withPlanDefaults(stage, script(stage, options));
  };
  const events: ServerEvent[] = [];
  const delivered: string[] = [];
  const engine = createPipelineEngine({
    repositories: r,
    invocation: agents.invocation,
    adapters: {
      claude: createFakeAdapter("claude", run),
      copilot: createFakeAdapter("copilot", run),
    },
    stages,
    prepareWorkspace: async (task) => ({
      branch: task.branch ?? `agent/${task.id}`,
      worktreePath: dir,
    }),
    deliver: async (task) => {
      delivered.push(task.id);
    },
    maxTasksPerRepo: () => maxPerRepo,
    publish: (event) => events.push(event),
    log: () => undefined,
  });
  return { engine, calls, events, delivered };
}

function seedTask(patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {}): Task {
  const agents = createAgentService({ agents: r.agents, settings: r.settings, tags: r.tags });
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
    expect(task(seeded.id)).toMatchObject({ status: "done", gate: null });
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
