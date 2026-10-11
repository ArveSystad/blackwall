import {
  agentCliFor,
  deliveryConfirmationSchema,
  findingOverrideInputSchema,
  gateResponseInputSchema,
  grillAnswerInputSchema,
  TASK_STOPPED_ERROR,
  type AgentCli,
  type DeliveryConfirmation,
  type DeliveryPlan,
  type Finding,
  type FindingOverrideInput,
  type GateResponseInput,
  type GrillAnswerInput,
  type GrillAnswerResult,
  type Run,
  type ServerEvent,
  type Stage,
  type Step,
  type StepStatus,
  type Task,
} from "@blackwall/shared";
import type { AgentInvocation } from "../agents/service.js";
import type { AgentAdapter, AgentResult } from "../agents/adapters/types.js";
import type { QuotaTracker } from "../agents/quota.js";
import type { Repositories } from "../db/repositories.js";
import {
  DELIVERY_CONFLICT_EVENT,
  DELIVERY_DONE_EVENT,
  DELIVERY_FAILED_EVENT,
  ISSUE_COMMENT_EVENT,
  conflictResolutionPrompt,
  type Deliverer,
  type DeliveryOutcome,
  type DeliveryStep,
  type IssueCommentOutcome,
  type MergeConflict,
} from "./delivery.js";
import { blockingFindings } from "./findings.js";
import { createScheduler } from "./scheduler.js";
import {
  FIRST_STAGE,
  InvalidGateResponseError,
  afterGate,
  afterStage,
  pipelineKind,
  type PipelineKind,
  type PipelinePosition,
  type StageResults,
  type Transition,
} from "./transitions.js";

type TaskPatch = Parameters<Repositories["tasks"]["update"]>[1];

/** A gate answer as {@link gateResponseInputSchema} parsed it. */
type GateResponse = ReturnType<typeof gateResponseInputSchema.parse>;

/** A new task as the new task form describes it, with its role agents resolved. */
export type NewTaskValues = Pick<
  Task,
  | "title"
  | "origin"
  | "mode"
  | "repoId"
  | "freeText"
  | "agents"
  | "cli"
  | "agentClis"
  | "triageMode"
>;

/** Prompt sent when a step resumes its interrupted CLI session. */
export const RESUME_PROMPT =
  "You were interrupted. Continue the task from where you stopped and finish with your final answer.";

/** A task that is not in a state the requested action allows. */
export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Task ${id} not found`);
    this.name = "TaskNotFoundError";
  }
}

export class GrillQuestionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Question ${id} not found`);
    this.name = "GrillQuestionNotFoundError";
  }
}

export class FindingNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Finding ${id} not found`);
    this.name = "FindingNotFoundError";
  }
}

/** Thrown inside a stage when the engine is shutting down. */
class InterruptedError extends Error {
  constructor() {
    super("Interrupted");
    this.name = "InterruptedError";
  }
}

/**
 * A step stopped by its CLI's usage limit. The step and its task end
 * `interrupted`, so they resume (`--resume <sessionId>`) once the quota resets.
 */
export class RateLimitedError extends Error {
  constructor(
    readonly cli: AgentCli,
    readonly resumesAt: Date,
  ) {
    super(`The ${cli} usage limit was reached; resumes after ${resumesAt.toISOString()}`);
    this.name = "RateLimitedError";
  }
}

export interface RunAgentInput {
  agentId: string;
  prompt: string;
  /** JSON Schema the final answer must match; parsed into `structured`. */
  jsonSchema?: Record<string, unknown>;
  maxTurns?: number;
  /**
   * Resolve the agent's persona and permissions as for this stage instead of
   * the current one, e.g. the summarizer writing a commit message in Checks.
   * The step still belongs to the current stage.
   */
  asStage?: Stage;
  /**
   * Always start a new step and session, even when this agent already has a
   * step in the visit (e.g. one per conflict the implementer resolves).
   */
  fresh?: boolean;
}

/** What a stage handler gets: the task, where it is in the pipeline, and how to run agents. */
export interface StageContext {
  /** The task as of the stage start; kept current by {@link updateTask}. */
  readonly task: Task;
  readonly run: Run;
  readonly stage: Stage;
  readonly pipeline: PipelineKind;
  /** Fix round: 0 for the first implementation, then one per review loop. */
  readonly round: number;
  /** Visit of this stage within the run. */
  readonly visit: number;
  /** The user's message from the gate that led here (e.g. requested plan changes). */
  readonly instructions: string | undefined;
  /** Aborted on shutdown. */
  readonly signal: AbortSignal;
  readonly repositories: Repositories;
  /**
   * Runs one agent as a step of this stage, persisting and broadcasting its
   * events as they stream. On resume, a step that already succeeded in this
   * visit returns its stored result, and an interrupted one continues its CLI
   * session with `--resume`.
   */
  runAgent(input: RunAgentInput): Promise<AgentResult>;
  updateTask(patch: TaskPatch): Task;
  publish(event: ServerEvent): void;
}

export type StageHandlers = {
  [S in Stage]: (ctx: StageContext) => Promise<StageResults[S]>;
};

export interface PreparedWorkspace {
  branch: string;
  worktreePath: string;
}

export interface PipelineEngineOptions {
  repositories: Repositories;
  /** Resolves an agent's prompt, model and permissions for a stage on a CLI. */
  invocation: (agentId: string, stage: Stage, cli: AgentCli) => AgentInvocation;
  adapters: Partial<Record<AgentCli, AgentAdapter>>;
  stages: StageHandlers;
  /** Creates the task's worktree before its first stage. */
  prepareWorkspace: (task: Task) => Promise<PreparedWorkspace>;
  /**
   * Removes a deleted task's worktree and, unless it works on an existing PR
   * branch, its local branch. Called only for tasks that have a worktree.
   */
  removeWorkspace?: (task: Task) => Promise<void>;
  /** Plans and performs the delivery actions the user confirms at finish (or posts the review). */
  delivery: Deliverer;
  maxTasksPerRepo: () => number;
  /** Told about usage limits the CLIs hit, so the backlog runner can wait them out. */
  quota?: Pick<QuotaTracker, "report" | "succeeded">;
  publish?: (event: ServerEvent) => void;
  log?: (message: string) => void;
}

/** In-memory hints for a task's next drive; lost on restart, which only costs a re-run. */
interface Pending {
  round?: number;
  instructions?: string;
  /** Continue the latest visit of the stage instead of starting a new one. */
  resuming?: boolean;
}

export type PipelineEngine = ReturnType<typeof createPipelineEngine>;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Drives tasks through the hardcoded pipeline (see {@link afterStage}). Each
 * running task holds a scheduler slot until it reaches a gate, fails, is
 * interrupted or finishes. Steps, session ids and events are persisted as they
 * stream and broadcast through `publish`.
 */
export function createPipelineEngine({
  repositories: r,
  invocation,
  adapters,
  stages,
  prepareWorkspace,
  removeWorkspace = async () => undefined,
  delivery,
  maxTasksPerRepo,
  quota,
  publish = () => undefined,
  log = console.error,
}: PipelineEngineOptions) {
  const scheduler = createScheduler({ maxPerRepo: maxTasksPerRepo });
  const drives = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const pending = new Map<string, Pending>();
  /** Tasks whose delivery is in flight; a second confirmation must not run it twice. */
  const delivering = new Set<string>();
  /**
   * Tasks posting a plan-approval issue comment; other gate answers and delete
   * are refused until it settles.
   */
  const commenting = new Set<string>();
  /** Aborts the implementer resolving a delivery's conflicts; apart from {@link controllers}. */
  const deliveryControllers = new Map<string, AbortController>();
  /** Tasks the user stopped; their drive ends `interrupted` with {@link TASK_STOPPED_ERROR}. */
  const stopping = new Set<string>();
  let stopped = false;

  function getTask(id: string): Task {
    const task = r.tasks.get(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  function saveTask(id: string, patch: TaskPatch): Task {
    const task = r.tasks.update(id, patch);
    publish({ type: "task.upserted", payload: { task } });
    return task;
  }

  function saveRun(id: string, status: StepStatus, finishedAt: Date | null = null): Run {
    const run = r.runs.setStatus(id, status, finishedAt);
    publish({ type: "run.upserted", payload: { run } });
    return run;
  }

  function saveStep(id: string, patch: Parameters<Repositories["steps"]["update"]>[1]): Step {
    const step = r.steps.update(id, patch);
    publish({ type: "step.upserted", payload: { step } });
    return step;
  }

  /** The task's open run, or a new one when it has none (first start, or after finishing). */
  function currentRun(taskId: string): Run {
    const last = r.runs.listByTask(taskId).at(-1);
    if (last && last.finishedAt === null) return last;
    const run = r.runs.create(taskId);
    publish({ type: "run.upserted", payload: { run } });
    return run;
  }

  function latestRun(taskId: string): Run | undefined {
    return r.runs.listByTask(taskId).at(-1);
  }

  /** The fix round the run is in: the highest round any of its steps has reached. */
  function currentRound(run: Run | undefined): number {
    if (!run) return 0;
    return Math.max(0, ...r.steps.listByRun(run.id).map((s) => s.round));
  }

  /** Grill questions waiting on the user's answer. */
  function openQuestions(taskId: string): number {
    return r.grillQuestions.listByTask(taskId).filter((q) => q.needsHuman && q.answer === null)
      .length;
  }

  function position(task: Task, round: number): PipelinePosition {
    return { kind: pipelineKind(task.mode), triageMode: task.triageMode, round };
  }

  /** Findings that gate the loop now, the user's overrides included. */
  function blocking(taskId: string): Finding[] {
    return blockingFindings(r.findings.listByTask(taskId));
  }

  /**
   * The visit a stage runs as. A resumed stage continues its latest visit when
   * that visit has unfinished steps; anything else starts a new visit.
   */
  function chooseVisit(run: Run, stage: Stage, resuming: boolean): number {
    const own = r.steps.listByRun(run.id).filter((s) => s.stage === stage);
    if (own.length === 0) return 0;
    const latest = Math.max(...own.map((s) => s.visit));
    const unfinished = own.some((s) => s.visit === latest && s.status !== "succeeded");
    return resuming && unfinished ? latest : latest + 1;
  }

  /** The stored result of a succeeded step: the payload of its `result` event. */
  function storedResult(step: Step): AgentResult | undefined {
    const event = r.stepEvents
      .list(step.id)
      .filter((e) => e.type === "result")
      .at(-1);
    return (event?.payload as { result?: AgentResult } | undefined)?.result;
  }

  function stageContext(
    task: Task,
    run: Run,
    stage: Stage,
    round: number,
    visit: number,
    instructions: string | undefined,
    signal: AbortSignal,
  ): StageContext {
    const ctx = {
      task,
      run,
      stage,
      pipeline: pipelineKind(task.mode),
      round,
      visit,
      instructions,
      signal,
      repositories: r,
      publish,
      updateTask(patch: TaskPatch): Task {
        ctx.task = saveTask(task.id, patch);
        return ctx.task;
      },
      runAgent: (input: RunAgentInput) => runAgent(ctx, input),
    };
    return ctx;
  }

  async function runAgent(ctx: StageContext, input: RunAgentInput): Promise<AgentResult> {
    const { run, stage, round, visit, signal } = ctx;
    if (signal.aborted) throw new InterruptedError();
    const earlier = input.fresh
      ? undefined
      : r.steps
          .listByRun(run.id)
          .filter((s) => s.stage === stage && s.visit === visit && s.agentId === input.agentId)
          .at(-1);

    if (earlier?.status === "succeeded") {
      const stored = storedResult(earlier);
      if (stored) return stored;
    }

    // A resumed step stays on its own CLI, since its session belongs to that CLI.
    const cli = earlier?.cli ?? agentCliFor(ctx.task, input.agentId);
    const inv = invocation(input.agentId, input.asStage ?? stage, cli);
    const adapter = adapters[cli];
    if (!adapter) throw new Error(`No adapter for the ${cli} CLI`);

    const worktree = ctx.task.worktreePath;
    if (!worktree) throw new Error("The task has no worktree");

    // An interrupted step continues its CLI session; a failed one starts afresh.
    const resumeSessionId =
      earlier?.status === "interrupted" && earlier.sessionId ? earlier.sessionId : undefined;
    const started = { status: "running" as const, startedAt: new Date(), finishedAt: null };
    let step = earlier
      ? saveStep(earlier.id, { ...started, error: null })
      : r.steps.create({
          runId: run.id,
          stage,
          agentId: input.agentId,
          cli,
          round,
          visit,
          ...started,
        });
    if (!earlier) publish({ type: "step.upserted", payload: { step } });

    const agentRun = adapter.run({
      cwd: worktree,
      prompt: resumeSessionId ? RESUME_PROMPT : input.prompt,
      systemPrompt: inv.systemPrompt,
      permissions: inv.permissions,
      signal,
      ...(inv.model ? { model: inv.model } : {}),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    });

    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimit: { resetsAt?: string } | undefined;
    try {
      for await (const event of agentRun) {
        const stored = r.stepEvents.append(step.id, event.type, event);
        publish({ type: "step.event", payload: { event: stored } });
        if (event.type === "session" && event.sessionId !== step.sessionId) {
          step = saveStep(step.id, { sessionId: event.sessionId });
        }
        if (event.type === "rate-limit") {
          const resetsAt = rateLimit?.resetsAt ?? event.resetsAt;
          rateLimit = resetsAt ? { resetsAt } : {};
        }
      }
      const result = await agentRun.result;
      saveStep(step.id, { status: "succeeded", finishedAt: new Date() });
      quota?.succeeded(cli);
      return result;
    } catch (error) {
      if (signal.aborted) {
        saveStep(step.id, { status: "interrupted", finishedAt: new Date() });
        throw new InterruptedError();
      }
      if (rateLimit && quota) {
        const resetsAt = rateLimit.resetsAt ? new Date(rateLimit.resetsAt) : undefined;
        const until = quota.report(cli, {
          taskId: ctx.task.id,
          ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAt } : {}),
        });
        const limited = new RateLimitedError(cli, until);
        saveStep(step.id, {
          status: "interrupted",
          error: limited.message,
          finishedAt: new Date(),
        });
        throw limited;
      }
      saveStep(step.id, { status: "failed", error: errorMessage(error), finishedAt: new Date() });
      throw error;
    }
  }

  /**
   * Delivery actions already performed since the run's agents last worked,
   * from the delivery steps' logs. Work done after a delivery (one more fix
   * round) makes every action due again; the implementer resolving conflicts
   * during a delivery does not count as such work.
   */
  function completedDeliveries(run: Run | undefined): DeliveryStep[] {
    if (!run) return [];
    const steps = r.steps.listByRun(run.id);
    const deliveryVisits = new Set(
      steps
        .filter(
          (s) =>
            s.agentId === null &&
            r.stepEvents.list(s.id).some((e) => e.type.startsWith("delivery.")),
        )
        .map((s) => `${s.stage}:${s.visit}`),
    );
    const worked = steps.findLastIndex(
      (s) => s.agentId !== null && !deliveryVisits.has(`${s.stage}:${s.visit}`),
    );
    return steps
      .slice(worked + 1)
      .flatMap((s) => r.stepEvents.list(s.id))
      .filter((e) => e.type === DELIVERY_DONE_EVENT)
      .map((e) => (e.payload as DeliveryOutcome).action);
  }

  /**
   * Performs the confirmed delivery actions as a harness step of the task's
   * current stage, logging each one as it completes. Rebase conflicts go to
   * the task's implementer, each as a fresh agent step of the same visit. A
   * failure leaves the task at its gate with the error, and a retry skips what
   * was done.
   */
  async function runDelivery(
    task: Task,
    run: Run,
    confirmation: DeliveryConfirmation,
  ): Promise<void> {
    const stage = task.stage ?? "summarize";
    const controller = new AbortController();
    deliveryControllers.set(task.id, controller);
    let step: Step | undefined;
    const ensureStep = (): Step => {
      if (step) return step;
      step = r.steps.create({
        runId: run.id,
        stage,
        agentId: null,
        round: currentRound(run),
        visit: chooseVisit(run, stage, false),
        status: "running",
        startedAt: new Date(),
      });
      publish({ type: "step.upserted", payload: { step } });
      return step;
    };
    const log = (type: string, payload: unknown) => {
      const event = r.stepEvents.append(ensureStep().id, type, payload);
      publish({ type: "step.event", payload: { event } });
    };
    const resolveConflicts = async (conflict: MergeConflict): Promise<void> => {
      // Logged before the agent step exists: completedDeliveries relies on it.
      log(DELIVERY_CONFLICT_EVENT, conflict);
      const agentId = task.agents.implementer;
      if (!agentId) throw new Error("The task has no implementer agent to resolve the conflicts");
      const { round, visit } = ensureStep();
      const ctx = stageContext(task, run, stage, round, visit, undefined, controller.signal);
      await ctx.runAgent({
        agentId,
        prompt: conflictResolutionPrompt(task, conflict),
        asStage: "implement",
        fresh: true,
      });
    };

    try {
      await delivery.deliver({
        task,
        run,
        confirmation,
        completed: completedDeliveries(run),
        record: (outcome) => log(DELIVERY_DONE_EVENT, outcome),
        resolveConflicts,
      });
      if (step) saveStep(step.id, { status: "succeeded", finishedAt: new Date() });
    } catch (error) {
      // A confirmation that does not fit the plan is refused before anything happens.
      if (error instanceof InvalidGateResponseError) throw error;
      const message = errorMessage(error);
      log(DELIVERY_FAILED_EVENT, { message });
      saveStep(ensureStep().id, { status: "failed", error: message, finishedAt: new Date() });
      saveTask(task.id, { error: message });
      throw error;
    } finally {
      deliveryControllers.delete(task.id);
    }
  }

  /** Runs a task from its current stage until it reaches a gate, fails or is interrupted. */
  async function drive(taskId: string): Promise<void> {
    const controller = new AbortController();
    controllers.set(taskId, controller);
    const { signal } = controller;
    const hints = pending.get(taskId) ?? {};
    pending.delete(taskId);

    let run: Run | undefined;
    try {
      let task = getTask(taskId);
      run = currentRun(taskId);
      if (run.status !== "running") run = saveRun(run.id, "running");
      task = saveTask(taskId, { status: "running", gate: null, error: null });

      if (!task.worktreePath) {
        const workspace = await prepareWorkspace(task);
        task = saveTask(taskId, workspace);
        scheduler.setBranch(taskId, workspace.branch);
      }

      let stage = task.stage ?? FIRST_STAGE;
      let round = hints.round ?? currentRound(run);
      let instructions = hints.instructions;
      let resuming = hints.resuming ?? false;

      for (;;) {
        if (signal.aborted) throw new InterruptedError();
        if (task.stage !== stage) task = saveTask(taskId, { stage });
        const visit = chooseVisit(run, stage, resuming);
        const ctx = stageContext(task, run, stage, round, visit, instructions, signal);
        const handler = stages[stage] as (ctx: StageContext) => Promise<StageResults[Stage]>;
        const result = await handler(ctx);
        if (signal.aborted) throw new InterruptedError();
        task = ctx.task;
        resuming = false;
        instructions = undefined;

        const next: Transition = afterStage(stage, result, position(task, round));
        if (next.kind === "stage") {
          stage = next.stage;
          round = next.round;
          continue;
        }
        if (next.kind === "gate") {
          saveTask(taskId, { status: "needs-you", gate: next.gate });
          return;
        }
        throw new Error(`Unexpected transition ${next.kind} after ${stage}`);
      }
    } catch (error) {
      if (signal.aborted || error instanceof InterruptedError) {
        saveTask(taskId, {
          status: "interrupted",
          ...(stopping.has(taskId) ? { error: TASK_STOPPED_ERROR } : {}),
        });
        if (run) saveRun(run.id, "interrupted");
        return;
      }
      if (error instanceof RateLimitedError) {
        saveTask(taskId, { status: "interrupted", error: error.message });
        if (run) saveRun(run.id, "interrupted");
        return;
      }
      log(`Task ${taskId} failed: ${errorMessage(error)}`);
      saveTask(taskId, { status: "failed", error: errorMessage(error) });
      if (run) saveRun(run.id, "failed");
    } finally {
      controllers.delete(taskId);
    }
  }

  function pump(): void {
    if (stopped) return;
    for (const { id } of scheduler.take()) {
      const done = drive(id)
        .catch((error: unknown) => log(`Task ${id} crashed: ${errorMessage(error)}`))
        .finally(() => {
          drives.delete(id);
          scheduler.release(id);
          pump();
        });
      drives.set(id, done);
    }
  }

  function enqueueTask(task: Task): void {
    scheduler.enqueue({ id: task.id, repoId: task.repoId, branch: task.branch });
    pump();
  }

  /**
   * Posts the plan-approval comment the user confirmed on a GitHub issue
   * task's issue and logs it on the step the task waited on (the latest
   * Plan review step), without starting a new step or visit. Resolves with
   * the task as it is after the post, which must still wait on plan approval.
   * A failed post leaves the task at its gate for a retry.
   */
  async function commentAtPlanApproval(task: Task, body: string): Promise<Task> {
    const run = latestRun(task.id);
    const step = run && r.steps.listByRun(run.id).findLast((s) => s.stage === task.stage);
    if (!step) throw new TaskStateError(`Task ${task.id} has no step to log its issue comment on`);
    const { url } = await delivery.commentOnIssue(task, body);
    const payload: IssueCommentOutcome = { url, at: "plan-approval" };
    const event = r.stepEvents.append(step.id, ISSUE_COMMENT_EVENT, payload);
    publish({ type: "step.event", payload: { event } });
    const fresh = getTask(task.id);
    if (fresh.status !== "needs-you" || fresh.gate !== "plan-approval") {
      throw new TaskStateError(`Task ${task.id} changed while commenting on its issue`);
    }
    return fresh;
  }

  /**
   * Answers the gate a `needs-you` task waits on. The task re-enters the
   * queue at the stage the answer leads to, or delivers and finishes. The
   * questions gate opens only once every open question is answered. Approving
   * a GitHub issue task's plan with `issueComment` posts that comment first;
   * other answers (and delete) are refused while it posts.
   */
  async function respond(taskId: string, input: GateResponseInput): Promise<Task> {
    const parsed = gateResponseInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidGateResponseError(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const { gate, decision, issueComment } = parsed.data;
    const task = getTask(taskId);
    if (task.status !== "needs-you" || task.gate !== gate) {
      throw new TaskStateError(`Task ${taskId} is not waiting on ${gate}`);
    }
    if (commenting.has(taskId)) {
      throw new TaskStateError(`Task ${taskId} is already answering its gate`);
    }
    if (gate === "questions" && openQuestions(taskId) > 0) {
      throw new TaskStateError(`Task ${taskId} still has open questions`);
    }
    if (gate === "finish" && decision === "approve") {
      const pendingFixes = blocking(taskId).filter((f) => f.status === "force-fix").length;
      if (pendingFixes > 0 && pipelineKind(task.mode) === "work") {
        throw new TaskStateError(
          `${pendingFixes} force-fixed ${pendingFixes === 1 ? "finding is" : "findings are"} not fixed yet: revise to run one more fix round, or force-ignore ${pendingFixes === 1 ? "it" : "them"}`,
        );
      }
    }
    if (!issueComment) return answerGate(task, parsed.data);
    if (gate !== "plan-approval" || decision !== "approve" || task.origin.kind !== "github-issue") {
      throw new InvalidGateResponseError(
        "Only approving a GitHub issue task's plan can comment on the issue",
      );
    }
    commenting.add(taskId);
    try {
      return await answerGate(await commentAtPlanApproval(task, issueComment.body), parsed.data);
    } finally {
      commenting.delete(taskId);
    }
  }

  /**
   * Moves a task past the gate it waits on, per an answer {@link respond}
   * accepted. While delivery runs the task carries `delivering`, cleared
   * however delivery ends.
   */
  async function answerGate(
    task: Task,
    { gate, decision, message, delivery: confirmed }: GateResponse,
  ): Promise<Task> {
    const taskId = task.id;
    const run = latestRun(taskId);
    const next = afterGate(gate, decision, {
      ...position(task, currentRound(run)),
      blocking: blocking(taskId).length,
    });

    if (next.kind === "deliver") {
      if (!run) throw new TaskStateError(`Task ${taskId} has no run to deliver`);
      if (delivering.has(taskId)) throw new TaskStateError(`Task ${taskId} is already delivering`);
      // Nothing leaves the machine unless the user confirmed that action.
      const confirmation = confirmed ?? deliveryConfirmationSchema.parse({});
      delivering.add(taskId);
      saveTask(taskId, { delivering: true });
      try {
        await runDelivery(task, run, confirmation);
      } finally {
        delivering.delete(taskId);
        saveTask(taskId, { delivering: false });
      }
      saveRun(run.id, "succeeded", new Date());
      const delivered = [...new Set([...completedDeliveries(run), ...confirmation.actions])];
      return saveTask(taskId, {
        status: "done",
        gate: null,
        error: null,
        deliveryTargets: delivered.filter((d) => d !== "squash"),
      });
    }
    if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);

    pending.set(taskId, { round: next.round, ...(message ? { instructions: message } : {}) });
    const queued = saveTask(taskId, { status: "queued", gate: null, stage: next.stage });
    enqueueTask(queued);
    return queued;
  }

  /**
   * Whether anything of the task left the machine or reached local main: a
   * finished delivery, or an action a failed attempt already performed. The
   * optional squash only rewrites the task's own branch, so it does not count.
   */
  function hasDelivered(task: Task): boolean {
    if (task.deliveryTargets.length > 0) return true;
    return r.runs.listByTask(task.id).some((run) =>
      r.steps
        .listByRun(run.id)
        .filter((s) => s.agentId === null)
        .some((s) =>
          r.stepEvents
            .list(s.id)
            .some(
              (e) =>
                e.type === DELIVERY_DONE_EVENT &&
                (e.payload as DeliveryOutcome).action !== "squash",
            ),
        ),
    );
  }

  /**
   * Halts a queued or running task as `interrupted` with
   * {@link TASK_STOPPED_ERROR}: a queued one leaves the queue unstarted, a
   * running one has its agent CLIs killed like on shutdown, its step left
   * `interrupted` with the session id, so Resume continues that session.
   * Resolves once the drive has settled. Any other status is left as it is.
   */
  async function stop(taskId: string): Promise<Task> {
    const task = getTask(taskId);
    if (task.status !== "queued" && task.status !== "running") return task;
    stopping.add(taskId);
    try {
      scheduler.dequeue(taskId);
      pending.delete(taskId);
      controllers.get(taskId)?.abort();
      await drives.get(taskId);
      const settled = getTask(taskId);
      // A queued task never started a drive, or its drive ended before the abort.
      if (settled.status === "queued" || settled.status === "running") {
        return saveTask(taskId, { status: "interrupted", gate: null, error: TASK_STOPPED_ERROR });
      }
      return settled;
    } finally {
      stopping.delete(taskId);
    }
  }

  return {
    /** Creates a task from the new task form and queues it to start when a slot is free. */
    createTask(values: NewTaskValues): Task {
      const task = r.tasks.create({ ...values, status: "queued" });
      publish({ type: "task.upserted", payload: { task } });
      enqueueTask(task);
      return task;
    },

    /** Queues a `queued` task to start (or continue) its pipeline when a slot is free. */
    enqueue(taskId: string): void {
      const task = getTask(taskId);
      if (task.status !== "queued") {
        throw new TaskStateError(`Task ${taskId} is ${task.status}, not queued`);
      }
      enqueueTask(task);
    },

    respond,

    /**
     * What finishing the task would do, each action with its exact target,
     * and which actions a failed earlier attempt already performed.
     */
    async deliveryPlan(taskId: string): Promise<DeliveryPlan> {
      const task = getTask(taskId);
      return delivery.plan(task, completedDeliveries(latestRun(taskId)));
    },

    /**
     * The user's force-fix or force-ignore on a finding, at any severity and
     * at any time. It applies from the next aggregation: a force-ignored
     * blocker stops gating, and a force-fixed finding is fixed in the next
     * fix round (at the finish gate, revise to run that round).
     */
    overrideFinding(taskId: string, findingId: string, input: FindingOverrideInput): Finding {
      const parsed = findingOverrideInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new InvalidGateResponseError(parsed.error.issues.map((i) => i.message).join("; "));
      }
      getTask(taskId);
      const existing = r.findings.get(findingId);
      if (!existing || existing.taskId !== taskId) throw new FindingNotFoundError(findingId);
      if (existing.status === "merged") {
        throw new TaskStateError("This finding was merged into another; override that one instead");
      }
      const finding = r.findings.setStatus(findingId, parsed.data.status);
      publish({ type: "finding.upserted", payload: { finding } });
      return finding;
    },

    /**
     * Records the user's answer to a grill question only a human can decide.
     * Answering the last open question continues the task: Plan review folds
     * the answers into the plan and grills it again.
     */
    async answerQuestion(
      taskId: string,
      questionId: string,
      input: GrillAnswerInput,
    ): Promise<GrillAnswerResult> {
      const parsed = grillAnswerInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new InvalidGateResponseError(parsed.error.issues.map((i) => i.message).join("; "));
      }
      let task = getTask(taskId);
      const existing = r.grillQuestions.get(questionId);
      if (!existing || existing.taskId !== taskId) throw new GrillQuestionNotFoundError(questionId);
      if (!existing.needsHuman) {
        throw new TaskStateError("The planner answers this question from the repository");
      }
      if (task.status !== "needs-you" || task.gate !== "questions") {
        throw new TaskStateError(`Task ${taskId} is not waiting on answers`);
      }
      const question = r.grillQuestions.answer(questionId, parsed.data.answer, "user");
      publish({ type: "grill.upserted", payload: { question } });
      if (openQuestions(taskId) === 0) {
        task = await respond(taskId, { gate: "questions", decision: "approve" });
      }
      return { question, task };
    },

    /**
     * Re-queues an interrupted or failed task at its current stage. Steps that
     * succeeded in that stage's visit keep their results; interrupted steps
     * continue their CLI sessions with `--resume <sessionId>`.
     */
    resume(taskId: string): Task {
      const task = getTask(taskId);
      if (task.status !== "interrupted" && task.status !== "failed") {
        throw new TaskStateError(
          `Task ${taskId} is ${task.status}; only interrupted or failed tasks resume`,
        );
      }
      pending.set(taskId, { resuming: true });
      const queued = saveTask(taskId, { status: "queued", error: null });
      enqueueTask(queued);
      return queued;
    },

    /**
     * Archives a done task: it leaves the Inbox and the backlog lists but keeps
     * its status, so backlog dependencies on it stay met. Archiving an archived
     * task keeps its original `archivedAt`.
     */
    archive(taskId: string): Task {
      const task = getTask(taskId);
      if (task.status !== "done") {
        throw new TaskStateError(`Task ${taskId} is ${task.status}; only done tasks are archived`);
      }
      if (task.archivedAt) return task;
      return saveTask(taskId, { archivedAt: new Date() });
    },

    /** Lists an archived task again. */
    unarchive(taskId: string): Task {
      getTask(taskId);
      return saveTask(taskId, { archivedAt: null });
    },

    stop,

    /**
     * Deletes a task with its worktree, its local branch (kept for PR tasks,
     * which work on an existing branch) and its history. A queued or running
     * task is stopped first. Refused while delivery runs, while a plan-approval
     * issue comment posts, or once anything was delivered (progress comments
     * on an issue don't count). Backlog items that promoted it keep `taskId: null`.
     */
    async delete(taskId: string): Promise<void> {
      const task = getTask(taskId);
      if (delivering.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is delivering; it cannot be deleted now`);
      }
      if (commenting.has(taskId)) {
        throw new TaskStateError(
          `Task ${taskId} is commenting on its issue; it cannot be deleted now`,
        );
      }
      if (hasDelivered(task)) {
        throw new TaskStateError(
          `Task ${taskId} was already delivered; delete its branch or PR by hand instead`,
        );
      }
      await stop(taskId);
      // A gate answer may have queued it again meanwhile.
      scheduler.dequeue(taskId);
      pending.delete(taskId);
      await drives.get(taskId);
      const settled = getTask(taskId);
      if (settled.worktreePath) await removeWorkspace(settled);
      r.tasks.delete(taskId);
      publish({ type: "task.removed", payload: { taskId } });
    },

    /**
     * Startup recovery: steps and tasks a previous process left running become
     * `interrupted` (the user resumes them), queued tasks are scheduled, and a
     * `delivering` flag left by a delivery cut short is cleared.
     */
    recover(): void {
      for (const step of r.steps.interruptRunning()) {
        publish({ type: "step.upserted", payload: { step } });
      }
      for (const task of r.tasks.list()) {
        if (task.delivering) saveTask(task.id, { delivering: false });
        if (task.status === "running") {
          saveTask(task.id, { status: "interrupted" });
          const run = latestRun(task.id);
          if (run && run.finishedAt === null) saveRun(run.id, "interrupted");
        } else if (task.status === "queued") {
          scheduler.enqueue({ id: task.id, repoId: task.repoId, branch: task.branch });
        }
      }
      pump();
    },

    /**
     * Stops scheduling and aborts every running task, which kills its CLI
     * process trees and leaves its steps `interrupted`. Resolves once all have
     * settled.
     */
    async shutdown(): Promise<void> {
      stopped = true;
      for (const controller of controllers.values()) controller.abort();
      for (const controller of deliveryControllers.values()) controller.abort();
      await Promise.all(drives.values());
    },

    /** Resolves when no task is running (tests). */
    async idle(): Promise<void> {
      while (drives.size > 0) await Promise.all(drives.values());
    },

    /** Ids of running tasks and of tasks waiting for a slot. */
    activeTaskIds: (): string[] => scheduler.activeIds(),
    queuedTaskIds: (): string[] => scheduler.queuedIds(),
  };
}
