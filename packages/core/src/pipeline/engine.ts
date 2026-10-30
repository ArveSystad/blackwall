import {
  LOCKED_TRUST,
  agentCliFor,
  effectiveTrust,
  effortFlagApplies,
  deliveryConfirmationSchema,
  diffCommentsInputSchema,
  findingOverrideInputSchema,
  gateResponseInputSchema,
  grillAnswerInputSchema,
  TASK_STOPPED_ERROR,
  type AgentCli,
  type AgentTrust,
  type DeliveryConfirmation,
  type DeliveryConfirmationInput,
  type DeliveryPlan,
  type DeliveryTarget,
  type DiffCommentsInput,
  type DiffCommentsResult,
  type Finding,
  type FindingDeleteResult,
  type FindingOverrideInput,
  type GateResponseInput,
  type GrillAnswerInput,
  type GrillAnswerResult,
  type PullRequestRefresh,
  type Run,
  type ServerEvent,
  type Stage,
  type Step,
  type StepEvent,
  type StepStatus,
  type Task,
} from "@blackwall/shared";
import type { AgentInvocation } from "../agents/service.js";
import { AgentRunError, type AgentAdapter, type AgentResult } from "../agents/adapters/types.js";
import type { QuotaTracker } from "../agents/quota.js";
import type { Repositories } from "../db/repositories.js";
import { errorMessage } from "../git/errors.js";
import { sameSnapshot, type GitService } from "../git/service.js";
import type { RepoRenameLocks } from "../repos/rename-lock.js";
import { defaultBranchOf, referenceReposFrom, type ReferenceRepo } from "../repos/service.js";
import { MAX_CI_FAILURES, type CiWatcher } from "./ci.js";
import {
  DELIVERY_CONFLICT_EVENT,
  DELIVERY_DONE_EVENT,
  DELIVERY_EVENT_TYPES,
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
import {
  WorkspaceArchiveError,
  type PrHeadSync,
  type WorkspaceArchiver,
  type WorkspaceSync,
} from "./workspace.js";
import {
  MAX_PR_COMMENT_FINDINGS,
  prConversationFinding,
  prThreadFinding,
  seenPrCommentUrls,
  type PullRequestFeedback,
} from "./pr-feedback.js";
import { createScheduler } from "./scheduler.js";
import {
  SETUP_SKIPPED_EVENT,
  runSetupStep,
  type SetupSkipped,
  type WorktreeSetup,
} from "./setup.js";
import {
  addUsage,
  combine,
  emptyStepUsage,
  reconcile,
  usageOf,
  type StepUsageColumns,
} from "./usage.js";
import {
  NO_HUMAN_ANSWER,
  ciFailureFinding,
  commitKey,
  commitMessage,
  commitMessageRewritePrompt,
  diffCommentFinding,
  finishStep,
  lastReviewedRange,
  logEvent,
  startHarnessStep,
} from "./stages.js";
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
  | "referenceRepoIds"
  | "triageMode"
  | "inRepo"
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
   * step in the visit (e.g. one per conflict the implementer resolves). A
   * non-fresh call finds the visit's first step for its agent, so it must come
   * before any fresh calls of that agent in the visit.
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
  /** The user's guidance from a resume; reaches only the agent steps that failed or stopped. */
  readonly guidance: string | undefined;
  /** Aborted on shutdown. */
  readonly signal: AbortSignal;
  readonly repositories: Repositories;
  /** No human is in the loop: the planner answers every grill question itself. */
  readonly autonomous: boolean;
  /** Implement only: why the worktree's setup commands failed in this drive, if they did. */
  setupFailure: string | undefined;
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
  /** PR tasks: the pull request's base branch, when known. */
  baseBranch?: string | null;
}

export interface PipelineEngineOptions {
  repositories: Repositories;
  /**
   * Resolves an agent's prompt, model and permissions for a stage on a CLI;
   * read-only stages may also read the reference repos.
   */
  invocation: (
    agentId: string,
    stage: Stage,
    cli: AgentCli,
    referenceRepos?: readonly ReferenceRepo[],
    trust?: AgentTrust,
  ) => AgentInvocation;
  adapters: Partial<Record<AgentCli, AgentAdapter>>;
  stages: StageHandlers;
  /** Creates the task's worktree before its first stage. */
  prepareWorkspace: (task: Task) => Promise<PreparedWorkspace>;
  /**
   * Fetches the repo's remote default branch and fast-forwards a task branch
   * with no commits of its own to it before new work starts (Inform, Plan
   * review, the first Implement round). Failures are logged, never fatal.
   */
  syncWorkspace?: (task: Task) => Promise<WorkspaceSync | null>;
  /**
   * Removes a deleted task's worktree and, unless it works on an existing PR
   * branch, its local branch. `keepBranch` keeps the local branch too (a
   * delivered task's). Called only for tasks that have a worktree.
   */
  removeWorkspace?: (task: Task, options?: { keepBranch?: boolean }) => Promise<void>;
  /**
   * Removes an archived task's worktree in the background, keeping its head
   * at a hidden ref, and rebuilds it when the task is reopened. Without the
   * port archived tasks keep their worktrees.
   */
  archiveWorkspace?: WorkspaceArchiver;
  /** Ends anything else working in the task's worktree (its chat) before the worktree is removed. */
  beforeDelete?: (taskId: string) => Promise<void>;
  /** Plans and performs the delivery actions the user confirms at finish (or posts the review). */
  delivery: Deliverer;
  maxTasksPerRepo: () => number;
  /** Told about usage limits the CLIs hit, so the backlog runner can wait them out. */
  quota?: Pick<QuotaTracker, "report" | "succeeded">;
  publish?: (event: ServerEvent) => void;
  log?: (message: string) => void;
  /** Whether a worktree or repo folder exists; a task whose worktree is gone fails instead of running. */
  pathExists?: (path: string) => boolean;
  /** Watches CI after a delivery pushes the branch, and gathers the failing logs for Fix CI. */
  ci?: Pick<CiWatcher, "watch" | "cancel" | "failureContext">;
  /**
   * Reads the review threads and conversation on the pull request a delivery
   * opened, minus blackwall's own comments, for Fetch comments and fix.
   */
  prFeedback?: (url: string, signal?: AbortSignal) => Promise<PullRequestFeedback>;
  /**
   * Whether a PR task's branch holds only the user's own commits: the PR is
   * theirs, from the base repo, and so is every commit. Only a `true` lets a
   * PR task run above Locked; without the port, PR tasks stay Locked.
   */
  prBranchOwned?: (task: Task, signal: AbortSignal) => Promise<boolean>;
  /**
   * Snapshots and restores a worktree around each read-only agent step under
   * Trusted, so a read-only agent never leaves a change behind even if the
   * repo's skills widened what it may run. Unrestricted has no such backstop
   * by design. Without the port there is none either (tests only).
   */
  worktreeGuard?: Pick<GitService, "snapshotWorktree" | "restoreWorktree">;
  /**
   * Whether agents make every decision for the task (its repo is autonomous
   * and the task came from the repo's backlog). Read live at each gate; off
   * by default.
   */
  autonomous?: (task: Task) => boolean;
  /**
   * Runs the repo's setup commands (dependency install) in a work task's
   * worktree when its setup key changed since the last successful setup. Without
   * the port nothing runs (tests).
   */
  setup?: WorktreeSetup;
  /**
   * Fetches a Review PR task's head branch and moves its worktree there, for
   * Refresh and Re-review. Without the port both are refused.
   */
  prHead?: PrHeadSync;
  /**
   * Repo rename locks: while a repo is held its queued tasks wait, and
   * delivery, re-review and delete of its tasks are refused.
   */
  renaming?: Pick<RepoRenameLocks, "isHeld" | "assertFree" | "onRelease"> | undefined;
}

/** The only delivery actions autonomous mode takes: nothing leaves the machine. */
export const LOCAL_DELIVERY: readonly DeliveryTarget[] = ["merge-main", "create-tasks"];

/** Archived tasks keep their worktrees. */
const NO_ARCHIVER: WorkspaceArchiver = {
  archive: async () => null,
  restore: async () => {
    throw new Error("Restoring a removed worktree is not available");
  },
  forget: async () => undefined,
};

/**
 * The finish confirmation autonomous mode gives a delivery plan: the local
 * merge when due, and every offered follow-up, never a push, PR or comment.
 * Null when the plan offers only outbound code routes (no local merge), so
 * the task waits at finish for the user.
 */
export function localDelivery(plan: DeliveryPlan): DeliveryConfirmationInput | null {
  const offered = new Set(plan.actions.map((a) => a.kind));
  const done = new Set<string>(plan.completed);
  const outboundCode = offered.has("push-branch") || offered.has("open-pr");
  if (outboundCode && !offered.has("merge-main")) return null;
  const actions: DeliveryTarget[] = [];
  if (offered.has("merge-main") && !done.has("merge-main")) actions.push("merge-main");
  const createTasks = plan.actions.find((a) => a.kind === "create-tasks");
  const followUpIndexes =
    createTasks && createTasks.items.length > 0 && !done.has("create-tasks")
      ? createTasks.items.map((_, index) => index)
      : [];
  if (followUpIndexes.length > 0) actions.push("create-tasks");
  return {
    actions: actions.filter((a) => LOCAL_DELIVERY.includes(a)),
    squash: false,
    followUpIndexes,
  };
}

/** A read-only agent step under Trusted left the worktree changed; the harness put it back. */
export class WorktreeChangedError extends Error {
  constructor() {
    super("A read-only agent changed the worktree under Trusted");
    this.name = "WorktreeChangedError";
  }
}

type WorktreeSnapshot = Awaited<ReturnType<GitService["snapshotWorktree"]>>;

/** A guarded step's hold on its worktree's shared baseline; released once its check is done. */
interface SharedBaseline {
  snapshot: Promise<WorktreeSnapshot>;
  release: () => void;
}

/** In-memory hints for a task's next drive; lost on restart, which only costs a re-run. */
interface Pending {
  round?: number;
  instructions?: string;
  /** Continue the latest visit of the stage instead of starting a new one. */
  resuming?: boolean;
  /** The user's guidance from a resume, for the steps that failed or stopped. */
  guidance?: string;
}

export type PipelineEngine = ReturnType<typeof createPipelineEngine>;

/**
 * Drives tasks through the hardcoded pipeline (see {@link afterStage}). Each
 * running task holds a scheduler slot until it reaches a gate, fails, is
 * interrupted or finishes. Steps, session ids and events are persisted as they
 * stream and broadcast through `publish`. A step's token and cost totals rise
 * with each streamed `usage` event (broadcast as `step.usage`) and are
 * reconciled with the CLI's result when the step succeeds.
 */
export function createPipelineEngine({
  repositories: r,
  invocation,
  adapters,
  stages,
  prepareWorkspace,
  syncWorkspace,
  removeWorkspace = async () => undefined,
  archiveWorkspace = NO_ARCHIVER,
  beforeDelete,
  delivery,
  maxTasksPerRepo,
  quota,
  publish = () => undefined,
  log = console.error,
  pathExists = () => true,
  ci,
  prFeedback,
  prBranchOwned,
  worktreeGuard,
  autonomous = () => false,
  setup,
  prHead,
  renaming,
}: PipelineEngineOptions) {
  const scheduler = createScheduler({
    maxPerRepo: maxTasksPerRepo,
    held: (repoId) => renaming?.isHeld(repoId) ?? false,
  });
  renaming?.onRelease(() => pump());
  const drives = new Map<string, Promise<void>>();
  /** Worktree removals after archiving, by task; an entry goes when it settles. */
  const cleanups = new Map<string, Promise<void>>();
  /** Autonomous gate answers in flight after a drive (see {@link autopilot}). */
  const autopilots = new Set<Promise<void>>();
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
  /** Tasks gathering CI logs for a Fix CI; a second Fix CI is refused meanwhile. */
  const fixingCi = new Set<string>();
  /** Tasks fetching their PR's comments for a fix round; Fix CI and a second fetch are refused meanwhile. */
  const fixingPrComments = new Set<string>();
  /** Review tasks re-reviewing their PR; a second Re-review is refused meanwhile. */
  const refreshingPr = new Set<string>();
  /**
   * The last worktree guard call queued per worktree. Parallel read-only steps
   * (the review panel) share a worktree, and their snapshots and restores must
   * not run git on its index at the same time.
   */
  const guardQueues = new Map<string, Promise<unknown>>();
  const guarded = <T>(worktree: string, fn: () => Promise<T>): Promise<T> => {
    const run = (guardQueues.get(worktree) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => undefined);
    guardQueues.set(worktree, settled);
    void settled.then(() => {
      if (guardQueues.get(worktree) === settled) guardQueues.delete(worktree);
    });
    return run;
  };
  /**
   * The snapshot guarded steps running at once on a worktree all check against:
   * the one taken when the first of them started. A step starting later would
   * otherwise take a sibling's change as its baseline and put it back.
   */
  const guardBaselines = new Map<string, { snapshot: Promise<WorktreeSnapshot>; users: number }>();
  const shareBaseline = (
    worktree: string,
    take: () => Promise<WorktreeSnapshot>,
  ): SharedBaseline => {
    let shared = guardBaselines.get(worktree);
    if (!shared) {
      shared = { snapshot: guarded(worktree, take), users: 0 };
      guardBaselines.set(worktree, shared);
    }
    shared.users++;
    const entry = shared;
    return {
      snapshot: entry.snapshot,
      release: () => {
        entry.users--;
        if (entry.users === 0 && guardBaselines.get(worktree) === entry) {
          guardBaselines.delete(worktree);
        }
      },
    };
  };
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

  /** Saves a step's running usage totals only; avoids the refetches `step.upserted` triggers. */
  function saveStepUsage(id: string, usage: StepUsageColumns): Step {
    const step = r.steps.update(id, usage);
    publish({ type: "step.usage", payload: { step } });
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
    const event = r.stepEvents.lastOfType(step.id, "result");
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
    guidance?: string,
  ): StageContext {
    const ctx = {
      task,
      run,
      stage,
      pipeline: pipelineKind(task.mode),
      round,
      visit,
      instructions,
      guidance,
      signal,
      repositories: r,
      autonomous: autonomous(task),
      setupFailure: undefined as string | undefined,
      publish,
      updateTask(patch: TaskPatch): Task {
        ctx.task = saveTask(task.id, patch);
        return ctx.task;
      },
      runAgent: (input: RunAgentInput) => runAgent(ctx, input),
    };
    return ctx;
  }

  /**
   * Checks whether a work PR task's branch holds only the user's commits and
   * stores the answer (`owned` or `foreign`); a failed or aborted check, or no
   * port, stores `unchecked`, which keeps the task Locked. Only work PR tasks
   * on repos above Locked are checked: nothing else depends on the answer.
   */
  async function checkPrBranch(taskId: string, signal: AbortSignal): Promise<void> {
    const task = getTask(taskId);
    if (task.origin.kind !== "github-pr" || task.mode !== "work") return;
    const repo = r.repos.get(task.repoId);
    if (!repo || repo.agentTrust === "locked") return;
    let state: NonNullable<Task["prBranch"]> = "unchecked";
    if (prBranchOwned && !signal.aborted) {
      try {
        state = (await prBranchOwned(task, signal)) ? "owned" : "foreign";
      } catch (error) {
        log(`Task ${taskId}: could not check its PR branch: ${errorMessage(error)}`);
      }
    }
    if (signal.aborted) state = "unchecked";
    if (getTask(taskId).prBranch !== state) {
      const saved = r.tasks.setPrBranch(taskId, state);
      publish({ type: "task.upserted", payload: { task: saved } });
    }
  }

  /** The trust a task's agent steps run under now (see {@link effectiveTrust}). */
  function trustFor(taskId: string): AgentTrust {
    const task = getTask(taskId);
    const repo = r.repos.get(task.repoId);
    return repo ? effectiveTrust(repo, task) : LOCKED_TRUST;
  }

  async function runAgent(ctx: StageContext, input: RunAgentInput): Promise<AgentResult> {
    const { run, stage, round, visit, signal } = ctx;
    if (signal.aborted) throw new InterruptedError();
    // The first step: fresh steps of the same agent (e.g. commit-message rewrites) come after it.
    const earlier = input.fresh
      ? undefined
      : r.steps
          .listByRun(run.id)
          .find((s) => s.stage === stage && s.visit === visit && s.agentId === input.agentId);

    if (earlier?.status === "succeeded") {
      const stored = storedResult(earlier);
      if (stored) return stored;
    }

    // A resumed step stays on its own CLI, since its session belongs to that CLI.
    const cli = earlier?.cli ?? agentCliFor(ctx.task, input.agentId);
    const trust = trustFor(ctx.task.id);
    const inv = invocation(
      input.agentId,
      input.asStage ?? stage,
      cli,
      referenceReposFrom(r.repos, ctx.task.repoId, ctx.task.referenceRepoIds),
      trust,
    );
    // Recorded as passed: null when unset or the CLI takes none for this model.
    const effort = inv.effort && effortFlagApplies(cli, inv.model) ? inv.effort : null;
    const adapter = adapters[cli];
    if (!adapter) throw new Error(`No adapter for the ${cli} CLI`);

    const worktree = ctx.task.worktreePath;
    if (!worktree) throw new Error("The task has no worktree");

    // An interrupted step continues its CLI session, or starts afresh if the CLI
    // lost it; a failed one starts afresh.
    const resumeSessionId =
      earlier?.status === "interrupted" && earlier.sessionId ? earlier.sessionId : undefined;
    // Guidance from a resume reaches only the steps that failed or stopped.
    const guided =
      ctx.guidance && (earlier?.status === "failed" || earlier?.status === "interrupted")
        ? ctx.guidance
        : undefined;
    const withGuidance = (prompt: string) =>
      guided ? `${prompt}\n\n## Guidance from the user\n\n${guided}` : prompt;
    const started = {
      status: "running" as const,
      startedAt: new Date(),
      finishedAt: null,
      trust: trust.level,
      trustForced: trust.forced,
      effort,
    };
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

    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimit: { resetsAt?: string } | undefined;
    /** Usage of earlier attempts, this step's earlier runs included: tokens spent stay spent. */
    let base = usageOf(step);
    /** Usage of the current attempt: streamed, then reconciled with its result. */
    let attemptUsage = emptyStepUsage();

    const attempt = async (resumeSessionId?: string): Promise<AgentResult> => {
      base = combine(base, attemptUsage);
      attemptUsage = emptyStepUsage();
      let eventsHadCost = false;
      const agentRun = adapter.run({
        cwd: worktree,
        prompt: withGuidance(resumeSessionId ? RESUME_PROMPT : input.prompt),
        systemPrompt: inv.systemPrompt,
        permissions: inv.permissions,
        signal,
        ...(inv.model ? { model: inv.model } : {}),
        ...(effort ? { effort } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
      });
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
        if (event.type === "usage") {
          attemptUsage = addUsage(attemptUsage, event.usage);
          eventsHadCost ||= event.usage.costUsd !== undefined;
          step = saveStepUsage(step.id, combine(base, attemptUsage));
        }
      }
      const result = await agentRun.result;
      attemptUsage = reconcile(attemptUsage, result.usage, eventsHadCost);
      return result;
    };

    // The backstop: a read-only step under Trusted must leave the worktree as it
    // found it, staged changes and untracked files included (the summarizer
    // starts on a staged round). Any change is undone and fails the step.
    // In-repo tasks share the user's own checkout, where the user may edit
    // while agents work, so the backstop is off for them.
    const guard =
      worktreeGuard &&
      !ctx.task.inRepo &&
      inv.permissions.profile === "read-only" &&
      trust.level === "trusted"
        ? worktreeGuard
        : undefined;
    let before: WorktreeSnapshot | undefined;
    let baseline: SharedBaseline | undefined;
    // The check and the restore run as one queued call, so a parallel step's
    // check never sees the worktree half put back. Called once per lease.
    const keepWorktree = async (): Promise<void> => {
      const held = baseline;
      baseline = undefined;
      if (!guard || !held) return;
      try {
        if (!before) return;
        const snapshot = before;
        const changed = await guarded(worktree, async () => {
          const after = await guard.snapshotWorktree(worktree);
          if (sameSnapshot(snapshot, after)) return false;
          await guard.restoreWorktree(worktree, snapshot);
          return true;
        });
        if (changed) throw new WorktreeChangedError();
      } finally {
        held.release();
      }
    };

    try {
      if (guard) {
        baseline = shareBaseline(worktree, () => guard.snapshotWorktree(worktree));
        before = await baseline.snapshot;
      }
      let result: AgentResult;
      try {
        result = await attempt(resumeSessionId);
      } catch (error) {
        const lost =
          resumeSessionId !== undefined &&
          !signal.aborted &&
          !rateLimit &&
          error instanceof AgentRunError &&
          error.reason === "session-missing";
        if (!lost) throw error;
        // The CLI no longer has the session: run the original prompt once, afresh.
        result = await attempt();
      }
      await keepWorktree();
      saveStep(step.id, {
        status: "succeeded",
        finishedAt: new Date(),
        ...combine(base, attemptUsage),
      });
      quota?.succeeded(cli);
      return result;
    } catch (error) {
      // A step that failed or stopped is checked too; a change it left fails it.
      const changed =
        error instanceof WorktreeChangedError
          ? error
          : await keepWorktree().then(
              () => undefined,
              (guardError: unknown) => guardError,
            );
      if (changed) {
        saveStep(step.id, {
          status: "failed",
          error: errorMessage(changed),
          finishedAt: new Date(),
          ...combine(base, attemptUsage),
        });
        throw changed;
      }
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
    const byId = new Map(steps.map((s) => [s.id, s]));
    const deliveryVisits = new Set(
      r.stepEvents
        .listOfTypes(
          steps.filter((s) => s.agentId === null).map((s) => s.id),
          DELIVERY_EVENT_TYPES,
        )
        .map((e) => byId.get(e.stepId))
        .filter((s) => s !== undefined)
        .map((s) => `${s.stage}:${s.visit}`),
    );
    const worked = steps.findLastIndex(
      (s) => s.agentId !== null && !deliveryVisits.has(`${s.stage}:${s.visit}`),
    );
    const tail = steps.slice(worked + 1);
    const done = r.stepEvents.listOfTypes(
      tail.map((s) => s.id),
      [DELIVERY_DONE_EVENT],
    );
    return eventsInStepOrder(tail, done).map((e) => (e.payload as DeliveryOutcome).action);
  }

  /** `events` regrouped to follow `steps`, each step's in sequence order. */
  function eventsInStepOrder(steps: Step[], events: StepEvent[]): StepEvent[] {
    const byStep = new Map<string, StepEvent[]>();
    for (const e of events) byStep.set(e.stepId, [...(byStep.get(e.stepId) ?? []), e]);
    return steps.flatMap((s) => byStep.get(s.id) ?? []);
  }

  /**
   * Performs the confirmed delivery actions as a harness step of the task's
   * current stage, logging each one as it completes. Rebase conflicts go to
   * the task's implementer, each as a fresh agent step of the same visit, and
   * a squash message the commit-msg hook rejects to its summarizer, likewise;
   * the message that lands is saved on the task. A
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
    const summarizer = task.agents.summarizer;
    const rewriteCommitMessage = summarizer
      ? async (rejected: string, output: string): Promise<string> => {
          const { round, visit } = ensureStep();
          const ctx = stageContext(task, run, stage, round, visit, undefined, controller.signal);
          const result = await ctx.runAgent({
            agentId: summarizer,
            prompt: commitMessageRewritePrompt(task, rejected, output),
            asStage: "summarize",
            fresh: true,
          });
          return commitMessage(result.text, commitKey(task));
        }
      : undefined;
    const resolveConflicts = async (conflict: MergeConflict): Promise<void> => {
      // Logged before the agent step exists: completedDeliveries relies on it.
      log(DELIVERY_CONFLICT_EVENT, conflict);
      const agentId = task.agents.implementer;
      if (!agentId) throw new Error("The task has no implementer agent to resolve the conflicts");
      // Delivery may have fetched someone else's commits onto the branch.
      await checkPrBranch(task.id, controller.signal);
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
        ...(rewriteCommitMessage ? { rewriteCommitMessage } : {}),
        saveSquashMessage: (squashMessage) => saveTask(task.id, { squashMessage }),
        renameBranch: (branch) => {
          saveTask(task.id, { branch });
          scheduler.setBranch(task.id, branch);
        },
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

  /**
   * Runs a task from its current stage until it reaches a gate, fails or is
   * interrupted. A work task's worktree is set up (see {@link setup}) in the
   * background from the drive's first Inform or Plan review visit, and before
   * every Implement visit, which waits for it. The drive, and so its scheduler
   * slot, lasts until setup has settled, a gate included.
   */
  async function drive(taskId: string): Promise<void> {
    const controller = new AbortController();
    controllers.set(taskId, controller);
    const { signal } = controller;
    const hints = pending.get(taskId) ?? {};
    pending.delete(taskId);

    /** The setup this drive ran or skipped, by key: each key is tried once per drive. */
    let setupRun: { key: string; outcome: Promise<string | undefined> } | undefined;
    /** The background setup started from Inform or Plan review. */
    let inFlight: Promise<unknown> | undefined;

    /**
     * Makes sure the worktree is set up for the repo's current setup commands
     * and lockfiles: waits for setup in flight, then runs it when the key
     * matches neither this drive's last attempt nor the stamp of the last
     * successful setup. Resolves with why setup failed, if it did (the same
     * text for every later call with that key in the drive). Never throws.
     */
    async function ensureSetup(ctx: StageContext): Promise<string | undefined> {
      try {
        if (!setup || ctx.pipeline !== "work") return undefined;
        await inFlight;
        const worktree = ctx.task.worktreePath;
        const commands = r.repos.get(ctx.task.repoId)?.setupCommands ?? [];
        if (!worktree || commands.length === 0) return undefined;
        let key: string;
        let stamp: string | null;
        try {
          key = await setup.key(worktree, commands);
          stamp = await setup.readStamp(worktree);
        } catch (error) {
          const message = `Could not tell whether the worktree needs setup: ${errorMessage(error)}`;
          log(`Task ${taskId}: worktree setup failed: ${message}`);
          return message;
        }
        if (setupRun?.key === key) return await setupRun.outcome;
        if (stamp === key) {
          const step = startHarnessStep(ctx);
          logEvent(ctx, step.id, SETUP_SKIPPED_EVENT, { key } satisfies SetupSkipped);
          finishStep(ctx, step.id, { status: "succeeded", error: null });
          setupRun = { key, outcome: Promise.resolve(undefined) };
          return undefined;
        }
        const outcome = runSetupStep(ctx, setup, key, commands);
        setupRun = { key, outcome };
        const failure = await outcome;
        if (failure && !signal.aborted) {
          log(`Task ${taskId}: worktree setup failed: ${failure}`);
        }
        return failure;
      } catch (error) {
        const message = errorMessage(error);
        log(`Task ${taskId}: worktree setup failed: ${message}`);
        return message;
      }
    }

    let run: Run | undefined;
    try {
      let task = getTask(taskId);
      run = currentRun(taskId);
      if (run.status !== "running") run = saveRun(run.id, "running");
      saveTask(taskId, { status: "running", gate: null, error: null });
      // Archiving may have removed the worktree; bring it back first.
      task = await ensureWorkspace(taskId);

      // An in-repo task prepares on every drive, so a resumed one gets its
      // branch checked out in the repo's folder again.
      if (!task.worktreePath || task.inRepo) {
        const workspace = await prepareWorkspace(task);
        task = saveTask(taskId, workspace);
        scheduler.setBranch(taskId, workspace.branch);
      } else if (!pathExists(task.worktreePath)) {
        throw new Error(
          `The task's worktree is missing at ${task.worktreePath}; it was not part of the import or was removed. Delete the task, or recreate the worktree to resume.`,
        );
      }
      // Once per drive: the branch may have gained commits since the last one.
      await checkPrBranch(taskId, signal);
      task = getTask(taskId);

      let stage = task.stage ?? FIRST_STAGE;
      let round = hints.round ?? currentRound(run);
      // New work starts on the newest default branch; later stages keep HEAD
      // where it is, as their review ranges depend on it.
      if (
        syncWorkspace &&
        !hints.resuming &&
        pipelineKind(task.mode) === "work" &&
        (stage === "inform" || stage === "plan-review" || (stage === "implement" && round === 0))
      ) {
        try {
          const synced = await syncWorkspace(task);
          if (synced?.fetchError) {
            log(
              `Task ${taskId}: could not fetch origin's ${defaultBranchOf(r.repos, task.repoId)}; using the local branch: ${synced.fetchError}`,
            );
          }
          if (synced?.fastForward) {
            const { onto, sha } = synced.fastForward;
            log(`Task ${taskId}: ${task.branch} fast-forwarded to ${onto} at ${sha}`);
          }
        } catch (error) {
          log(`Task ${taskId}: could not bring its branch up to date: ${errorMessage(error)}`);
        }
        task = getTask(taskId);
      }
      let instructions = hints.instructions;
      let guidance = hints.guidance;
      let resuming = hints.resuming ?? false;
      let first = true;

      for (;;) {
        if (signal.aborted) throw new InterruptedError();
        if (task.stage !== stage) task = saveTask(taskId, { stage });
        const visit = chooseVisit(run, stage, resuming);
        const ctx = stageContext(task, run, stage, round, visit, instructions, signal, guidance);
        // Setup runs alongside the planner, as part of this visit. The Trusted
        // backstop would undo what it writes during a read-only step, so those
        // tasks set up just before Implement instead. In-repo tasks have no
        // backstop, so they set up alongside the planner too.
        if (
          first &&
          (stage === "inform" || stage === "plan-review") &&
          !(worktreeGuard && trustFor(taskId).level === "trusted" && !task.inRepo)
        ) {
          inFlight = ensureSetup(ctx);
        }
        first = false;
        if (stage === "implement") {
          ctx.setupFailure = await ensureSetup(ctx);
          if (signal.aborted) throw new InterruptedError();
        }
        const handler = stages[stage] as (ctx: StageContext) => Promise<StageResults[Stage]>;
        const result = await handler(ctx);
        if (signal.aborted) throw new InterruptedError();
        task = ctx.task;
        resuming = false;
        instructions = undefined;
        guidance = undefined;

        let next: Transition = afterStage(stage, result, position(task, round));
        // A force-fix the user clicked after the last Aggregate (say, while
        // Summarize ran) gets its fix round before the task stops at Finish.
        if (
          next.kind === "gate" &&
          next.gate === "finish" &&
          pipelineKind(task.mode) === "work" &&
          blocking(taskId).some((f) => f.status === "force-fix")
        ) {
          next = afterGate("finish", "revise", position(task, round));
        }
        if (next.kind === "stage") {
          stage = next.stage;
          round = next.round;
          continue;
        }
        if (next.kind === "gate") {
          saveTask(taskId, { status: "needs-you", gate: next.gate });
          // Holds the repo's slot until setup is done; an early answer waits in the queue.
          await inFlight;
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
      // A failed or interrupted drive never leaves setup running.
      if (inFlight) {
        controller.abort();
        await inFlight;
      }
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
          const piloted = autopilot(id).catch((error: unknown) =>
            log(`Task ${id}: autonomous mode failed: ${errorMessage(error)}`),
          );
          autopilots.add(piloted);
          void piloted.finally(() => autopilots.delete(piloted));
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
   * however delivery ends. A delivery adds to the targets earlier ones
   * reached (a Fix CI round delivers again), and one that pushed the branch
   * starts watching CI on the pushed commit.
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
      renaming?.assertFree(task.repoId);
      // Nothing leaves the machine unless the user confirmed that action.
      const confirmation = confirmed ?? deliveryConfirmationSchema.parse({});
      delivering.add(taskId);
      saveTask(taskId, { delivering: true });
      try {
        await runDelivery(await ensureWorkspace(taskId), run, confirmation);
      } finally {
        delivering.delete(taskId);
        saveTask(taskId, { delivering: false });
      }
      saveRun(run.id, "succeeded", new Date());
      const delivered = [...new Set([...completedDeliveries(run), ...confirmation.actions])];
      const targets = delivered.filter((d) => d !== "squash");
      const done = saveTask(taskId, {
        status: "done",
        gate: null,
        error: null,
        deliveryTargets: [...new Set([...getTask(taskId).deliveryTargets, ...targets])],
      });
      if (targets.includes("push-branch")) void ci?.watch(taskId);
      return done;
    }
    if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);
    return queueStage(taskId, next, message);
  }

  /**
   * Removes an archived task's worktree. A removal is recorded whatever
   * `archivedAt` is by then, so a task reopened meanwhile has its worktree
   * rebuilt by {@link ensureWorkspace}. Failures are logged, never thrown; a
   * partial removal is recorded too, keeping the leftover path.
   */
  async function cleanupArchived(taskId: string): Promise<void> {
    try {
      const task = getTask(taskId);
      const repo = r.repos.get(task.repoId);
      if (!repo || !pathExists(repo.path)) return;
      const removed = await archiveWorkspace.archive(task);
      if (removed) saveTask(taskId, { worktreePath: null, worktreeRemovedAt: new Date() });
    } catch (error) {
      log(`Task ${taskId}: could not remove its worktree after archiving: ${errorMessage(error)}`);
      if (error instanceof WorkspaceArchiveError && error.partial && r.tasks.get(taskId)) {
        saveTask(taskId, { worktreeRemovedAt: new Date() });
      }
    }
  }

  /**
   * Starts {@link cleanupArchived} in the background unless one already runs
   * for the task (say, unarchived and archived again meanwhile).
   */
  function startCleanup(taskId: string): void {
    if (cleanups.has(taskId)) return;
    const cleanup = cleanupArchived(taskId).finally(() => cleanups.delete(taskId));
    cleanups.set(taskId, cleanup);
  }

  /**
   * Rebuilds a task's worktree that archiving removed, after waiting for a
   * removal still in flight. Returns the fresh task; a failed rebuild throws,
   * so nothing runs without its worktree.
   */
  async function ensureWorkspace(taskId: string): Promise<Task> {
    await cleanups.get(taskId);
    const task = getTask(taskId);
    if (!task.worktreeRemovedAt) return task;
    const { worktreePath, branch } = await archiveWorkspace.restore(task);
    return saveTask(taskId, { worktreePath, branch, worktreeRemovedAt: null });
  }

  /**
   * Checks that a task is a done Review PR task that posted its review and
   * returns the PR head port, for Refresh and Re-review.
   */
  function reReviewable(task: Task): PrHeadSync {
    if (pipelineKind(task.mode) !== "review" || task.origin.kind !== "github-pr") {
      throw new TaskStateError(`Task ${task.id} does not review a pull request`);
    }
    if (task.status !== "done") throw new TaskStateError(`Task ${task.id} is not done`);
    if (!task.deliveryTargets.includes("pr-review")) {
      throw new TaskStateError(`Task ${task.id} has not posted its review`);
    }
    if (!(task.worktreePath || task.worktreeRemovedAt) || !task.branch) {
      throw new TaskStateError(`Task ${task.id} has no worktree`);
    }
    if (!prHead) throw new TaskStateError("Refreshing the pull request is not available");
    return prHead;
  }

  /** The head a Review PR task last reviewed and where the PR's head is now. */
  async function fetchPrHead(task: Task, port: PrHeadSync): Promise<PullRequestRefresh> {
    const reviewed = lastReviewedRange(r, task.id);
    if (!reviewed) throw new TaskStateError("No review is recorded for this task");
    const headSha = await port.fetch(task);
    return { reviewedSha: reviewed.to, headSha, changed: headSha !== reviewed.to };
  }

  /** Queues a task to continue at `next`, with the user's instructions if any. */
  function queueStage(
    taskId: string,
    next: { stage: Stage; round: number },
    message?: string,
  ): Task {
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
      r.stepEvents
        .listOfTypes(
          r.steps
            .listByRun(run.id)
            .filter((s) => s.agentId === null)
            .map((s) => s.id),
          [DELIVERY_DONE_EVENT],
        )
        .some((e) => (e.payload as DeliveryOutcome).action !== "squash"),
    );
  }

  /** The link of the last pull request a delivery of the task opened, if any. */
  function openedPullRequestUrl(taskId: string): string | undefined {
    let url: string | undefined;
    for (const run of r.runs.listByTask(taskId)) {
      const harness = r.steps.listByRun(run.id).filter((s) => s.agentId === null);
      const done = r.stepEvents.listOfTypes(
        harness.map((s) => s.id),
        [DELIVERY_DONE_EVENT],
      );
      for (const e of eventsInStepOrder(harness, done)) {
        const outcome = e.payload as DeliveryOutcome;
        if (outcome.action === "open-pr" && /^https?:\/\//.test(outcome.detail)) {
          url = outcome.detail;
        }
      }
    }
    return url;
  }

  /**
   * Halts a queued or running task as `interrupted` with
   * {@link TASK_STOPPED_ERROR}: a queued one leaves the queue unstarted, a
   * running one has its agent CLIs killed like on shutdown, its step left
   * `interrupted` with the session id, so Resume continues that session.
   * Resolves once the drive has settled. A task waiting at a gate keeps its
   * gate, so Resume puts it back there; one delivering or commenting on its
   * issue is left as it is, like any other status.
   */
  async function stop(taskId: string): Promise<Task> {
    const task = getTask(taskId);
    if (task.status === "needs-you") {
      if (delivering.has(taskId) || commenting.has(taskId)) return task;
      // A drive still setting up the worktree at its gate stops that setup.
      controllers.get(taskId)?.abort();
      return saveTask(taskId, { status: "interrupted", error: TASK_STOPPED_ERROR });
    }
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

  /**
   * Autonomous mode: answers the gate a `needs-you` work task waits on as an
   * agent would, through {@link respond} so every check still applies. Open
   * questions get {@link NO_HUMAN_ANSWER}; plan approval and triage are
   * approved; finish delivers locally only (see {@link localDelivery}).
   * Escalations, and finishes with only outbound routes, wait for the user.
   */
  async function autopilot(taskId: string): Promise<void> {
    if (stopped) return;
    const task = r.tasks.get(taskId);
    if (!task || task.status !== "needs-you" || task.delivering || !task.gate) return;
    if (pipelineKind(task.mode) !== "work" || !autonomous(task)) return;
    if (delivering.has(taskId) || commenting.has(taskId)) return;
    const gate = task.gate;
    switch (gate) {
      case "questions": {
        for (const q of r.grillQuestions.listByTask(taskId)) {
          if (!q.needsHuman || q.answer !== null) continue;
          const question = r.grillQuestions.answer(q.id, NO_HUMAN_ANSWER, "agent");
          publish({ type: "grill.upserted", payload: { question } });
        }
        await respond(taskId, { gate, decision: "approve" });
        break;
      }
      case "plan-approval":
      case "triage":
        await respond(taskId, { gate, decision: "approve" });
        break;
      case "finish": {
        const confirmation = localDelivery(
          await delivery.plan(task, completedDeliveries(latestRun(taskId))),
        );
        if (!confirmation) {
          log(`Task ${taskId}: autonomous finish left for the user (no local merge offered)`);
          return;
        }
        await respond(taskId, { gate, decision: "approve", delivery: confirmation });
        break;
      }
      case "escalation":
        return;
    }
    log(`Task ${taskId}: autonomous ${gate} approve`);
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
     * Runs autonomous mode on every task of the repo waiting at a gate: those
     * that reached it before autonomy was switched on, or before a restart.
     * Errors are logged per task.
     */
    async autopilotRepo(repoId: string): Promise<void> {
      const waiting = r.tasks.list().filter((t) => t.repoId === repoId && t.status === "needs-you");
      for (const task of waiting) {
        await autopilot(task.id).catch((error: unknown) =>
          log(`Task ${task.id}: autonomous mode failed: ${errorMessage(error)}`),
        );
      }
    },

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
     * fix round. A force-fix while the task waits at the finish gate starts
     * that round straight away; one arriving after the last Aggregate (say,
     * during Summarize) runs it before the task reaches the finish gate.
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

      const task = getTask(taskId);
      if (
        finding.status === "force-fix" &&
        existing.status !== "force-fix" &&
        task.status === "needs-you" &&
        task.gate === "finish" &&
        pipelineKind(task.mode) === "work" &&
        !delivering.has(taskId) &&
        !commenting.has(taskId)
      ) {
        const next = afterGate("finish", "revise", position(task, currentRound(latestRun(taskId))));
        if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);
        queueStage(taskId, next);
      }
      return finding;
    },

    /**
     * The user's comments on hunks of the branch diff, sent together while a
     * work task waits at the finish, triage or escalation gate, or a review
     * task waits at triage. Each becomes a finding (see
     * {@link diffCommentFinding}). In a work task it is force-fixed: at finish
     * and escalation the comments start one more fix round straight away,
     * which at escalation counts as "revise"; at triage the task stays at its
     * gate and approving it runs the fix round the new blockers call for. In
     * a review task it is open and the task stays at triage, its comments
     * offered for posting to the pull request with the reviewers' findings.
     */
    commentOnDiff(taskId: string, input: DiffCommentsInput): DiffCommentsResult {
      const parsed = diffCommentsInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new InvalidGateResponseError(parsed.error.issues.map((i) => i.message).join("; "));
      }
      const task = getTask(taskId);
      const gate = task.gate;
      const kind = pipelineKind(task.mode);
      const commentable =
        kind === "review"
          ? gate === "triage"
          : gate === "finish" || gate === "triage" || gate === "escalation";
      if (task.status !== "needs-you" || !gate || !commentable) {
        throw new TaskStateError(`Task ${taskId} is not waiting on a review of its code`);
      }
      if (delivering.has(taskId) || commenting.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is already answering its gate`);
      }
      const run = latestRun(taskId);
      if (!run) throw new TaskStateError(`Task ${taskId} has no run to comment on`);
      const round = currentRound(run);
      const findings = r.findings.createMany(
        parsed.data.comments.map((c) => diffCommentFinding(task, run.id, round, c, kind)),
      );
      for (const finding of findings) publish({ type: "finding.upserted", payload: { finding } });

      if (kind === "work" && gate !== "triage") {
        const next = afterGate(gate, "revise", position(task, round));
        if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);
        queueStage(taskId, next);
      }
      return { findings, task: getTask(taskId) };
    },

    /**
     * Fix CI: a done work task whose CI failed gets one Critical force-fixed
     * finding per failing check (at most {@link MAX_CI_FAILURES}) with the end
     * of its log, in a new run, and is queued for a fix round. From there the
     * normal loop runs (Checks, Code review, Aggregate, Summarize) and the
     * task stops at the finish gate, where the user confirms the push again.
     * Lists the task again if it was archived.
     */
    async fixCi(taskId: string): Promise<Task> {
      const task = getTask(taskId);
      if (pipelineKind(task.mode) !== "work") {
        throw new TaskStateError(`Task ${taskId} only reviews; it has no CI to fix`);
      }
      if (task.status !== "done" || task.ci?.state !== "failed") {
        throw new TaskStateError(`Task ${taskId} has no failed CI to fix`);
      }
      if (fixingCi.has(taskId)) throw new TaskStateError(`Task ${taskId} is already fixing CI`);
      if (fixingPrComments.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is already fetching its PR comments`);
      }
      fixingCi.add(taskId);
      try {
        ci?.cancel(taskId);
        const failures = ci
          ? await ci.failureContext(task)
          : task.ci.checks
              .filter((c) => c.state === "failed")
              .slice(0, MAX_CI_FAILURES)
              .map((check) => ({ check, log: undefined }));
        if (getTask(taskId).status !== "done") {
          throw new TaskStateError(`Task ${taskId} changed while gathering its CI logs`);
        }
        const fresh = await ensureWorkspace(taskId);
        const run = currentRun(taskId);
        const round = currentRound(run);
        const findings = r.findings.createMany(
          failures
            .slice(0, MAX_CI_FAILURES)
            .map((failure) => ciFailureFinding(fresh, run.id, round, failure)),
        );
        for (const finding of findings) publish({ type: "finding.upserted", payload: { finding } });
        if (fresh.archivedAt) saveTask(taskId, { archivedAt: null });
        const next = afterGate("finish", "revise", position(fresh, round));
        if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);
        return queueStage(taskId, next);
      } finally {
        fixingCi.delete(taskId);
      }
    },

    /**
     * Fetch comments and fix: a done work task whose delivery opened a pull
     * request gets one High force-fixed finding per review thread with
     * comments no finding of the task has carried yet (outdated threads
     * included), plus one for new conversation comments and review summaries,
     * at most {@link MAX_PR_COMMENT_FINDINGS}; the rest come on the next call.
     * Each finding records its comments' permalinks (`Comment: <url>`), so a
     * comment is fixed only once. The CI watch is cancelled, the task queued
     * for a fix round and, like Fix CI, stops at the finish gate for the user
     * to push again. Lists the task again if it was archived.
     */
    async fixPrComments(taskId: string): Promise<Task> {
      const task = getTask(taskId);
      if (pipelineKind(task.mode) !== "work") {
        throw new TaskStateError(`Task ${taskId} only reviews; it has no pull request to fix`);
      }
      if (task.status !== "done") throw new TaskStateError(`Task ${taskId} is not done`);
      const url = openedPullRequestUrl(taskId);
      if (!url) throw new TaskStateError(`Task ${taskId} has not opened a pull request`);
      if (!prFeedback) throw new TaskStateError("Fetching PR comments is not available");
      if (fixingPrComments.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is already fetching its PR comments`);
      }
      if (fixingCi.has(taskId)) throw new TaskStateError(`Task ${taskId} is already fixing CI`);
      fixingPrComments.add(taskId);
      try {
        const feedback = await prFeedback(url);
        let fresh = getTask(taskId);
        if (fresh.status !== "done") {
          throw new TaskStateError(`Task ${taskId} changed while fetching its PR comments`);
        }
        const run = currentRun(taskId);
        const round = currentRound(run);
        const seen = seenPrCommentUrls(r.findings.listByTask(taskId));
        const prNumber = Number(/\/pulls?\/(\d+)/.exec(url)?.[1] ?? 0);
        const candidates = [
          ...feedback.threads.map((t) => prThreadFinding(fresh, run.id, round, t, seen)),
          prConversationFinding(fresh, run.id, round, prNumber, feedback.conversation, seen),
        ].filter((f) => f !== undefined);
        if (candidates.length === 0) {
          throw new TaskStateError("No new comments on the pull request to fix");
        }
        fresh = await ensureWorkspace(taskId);
        ci?.cancel(taskId);
        const findings = r.findings.createMany(candidates.slice(0, MAX_PR_COMMENT_FINDINGS));
        for (const finding of findings) publish({ type: "finding.upserted", payload: { finding } });
        if (fresh.archivedAt) saveTask(taskId, { archivedAt: null });
        const next = afterGate("finish", "revise", position(fresh, round));
        if (next.kind !== "stage") throw new Error(`Unexpected transition ${next.kind}`);
        return queueStage(taskId, next);
      } finally {
        fixingPrComments.delete(taskId);
      }
    },

    /**
     * Refresh: fetches a done Review PR task's head branch and reports
     * whether it moved since the review. Never touches the worktree.
     */
    async refreshPullRequest(taskId: string): Promise<PullRequestRefresh> {
      const task = getTask(taskId);
      return fetchPrHead(task, reReviewable(task));
    },

    /**
     * Re-review: when a done Review PR task's head branch moved since its
     * review, moves the clean worktree to the new head and queues Code review
     * in a new run, which reviews only the commits pushed since (the whole PR
     * after a force-push) and stops at triage for a follow-up review. Inform
     * is skipped; it does nothing for review tasks. Lists the task again if it
     * was archived.
     */
    async reReviewPullRequest(taskId: string): Promise<Task> {
      const task = getTask(taskId);
      renaming?.assertFree(task.repoId);
      const port = reReviewable(task);
      if (refreshingPr.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is already re-reviewing its pull request`);
      }
      refreshingPr.add(taskId);
      try {
        const { reviewedSha, headSha, changed } = await fetchPrHead(task, port);
        if (!changed) {
          throw new TaskStateError("No new changes on the pull request since the review");
        }
        if (getTask(taskId).status !== "done") {
          throw new TaskStateError(`Task ${taskId} changed while fetching its pull request`);
        }
        const fresh = await ensureWorkspace(taskId);
        if (!(await port.moveTo(fresh, headSha, reviewedSha))) {
          throw new TaskStateError(
            "The worktree of this review has local changes; clean it, then re-review",
          );
        }
        if (fresh.archivedAt) saveTask(taskId, { archivedAt: null });
        currentRun(taskId);
        return queueStage(taskId, { stage: "code-review", round: 0 });
      } finally {
        refreshingPr.delete(taskId);
      }
    },

    /**
     * Deletes a finding the user does not want posted, with the duplicates
     * merged into it, while a review task waits at triage. Work tasks only
     * force-ignore findings: theirs feed fix rounds and the summary.
     */
    deleteFinding(taskId: string, findingId: string): FindingDeleteResult {
      const task = getTask(taskId);
      const existing = r.findings.get(findingId);
      if (!existing || existing.taskId !== taskId) throw new FindingNotFoundError(findingId);
      if (
        task.status !== "needs-you" ||
        task.gate !== "triage" ||
        pipelineKind(task.mode) !== "review"
      ) {
        throw new TaskStateError(`Task ${taskId} is not waiting at review triage`);
      }
      if (delivering.has(taskId) || commenting.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is already answering its gate`);
      }
      if (existing.status === "merged") {
        throw new TaskStateError("This finding was merged into another; delete that one instead");
      }
      if (existing.status === "fixed") {
        throw new TaskStateError("This finding is fixed; it cannot be deleted");
      }
      const deletedIds = r.findings.deleteWithMerged(findingId);
      publish({ type: "finding.deleted", payload: { taskId, findingIds: deletedIds } });
      return { deletedIds };
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
     * continue their CLI sessions with `--resume <sessionId>`, or start afresh
     * if the CLI lost the session. A task stopped while it waited at a gate
     * goes straight back to that gate, without running anything. `message`
     * is the user's guidance for the agent steps that failed or stopped; it is
     * refused for a task stopped at a gate, which takes messages at the gate.
     */
    resume(taskId: string, message?: string): Task {
      const task = getTask(taskId);
      if (task.status !== "interrupted" && task.status !== "failed") {
        throw new TaskStateError(
          `Task ${taskId} is ${task.status}; only interrupted or failed tasks resume`,
        );
      }
      // Only a stop at a gate leaves an interrupted task with its gate.
      if (task.status === "interrupted" && task.gate !== null) {
        if (message) {
          throw new TaskStateError(
            `Task ${taskId} goes back to its ${task.gate} gate on resume; message it there instead`,
          );
        }
        return saveTask(taskId, { status: "needs-you", error: null, archivedAt: null });
      }
      pending.set(taskId, { resuming: true, ...(message ? { guidance: message } : {}) });
      const queued = saveTask(taskId, { status: "queued", error: null, archivedAt: null });
      enqueueTask(queued);
      return queued;
    },

    /**
     * Archives a done task, or a delivered one that failed or was interrupted
     * (say, a stopped Fix CI round): it leaves the Inbox and the backlog lists
     * but keeps its status, so backlog dependencies on a done task stay met.
     * Archiving an archived task keeps its original `archivedAt`. The task's
     * worktree is removed in the background to save disk (see
     * {@link cleanupArchived}); archiving never waits for it or fails on it,
     * and reopening the task rebuilds it.
     */
    archive(taskId: string): Task {
      const task = getTask(taskId);
      const stopped = task.status === "failed" || task.status === "interrupted";
      if (task.status !== "done" && !(stopped && hasDelivered(task))) {
        throw new TaskStateError(
          `Task ${taskId} is ${task.status}; only done or delivered tasks are archived`,
        );
      }
      if (task.archivedAt) return task;
      const archived = saveTask(taskId, { archivedAt: new Date() });
      startCleanup(taskId);
      return archived;
    },

    /** Lists an archived task again. */
    unarchive(taskId: string): Task {
      getTask(taskId);
      return saveTask(taskId, { archivedAt: null });
    },

    stop,

    /**
     * Deletes a task with its worktree, its local branch (kept for PR tasks,
     * which work on an existing branch) and its history. A delivered task
     * keeps its local branch too, and everything it sent (pushed branch, pull
     * request, comments) stays. A queued or running task is stopped first.
     * Refused while delivery runs or while a plan-approval issue comment posts.
     * Backlog items that promoted it keep `taskId: null`. `beforeDelete` runs
     * once the task has stopped, before the worktree goes. For a task whose
     * worktree archiving removed, the hidden ref (and any leftover folder)
     * goes, and a delivered task's branch is recreated from the ref.
     */
    async delete(taskId: string): Promise<void> {
      const task = getTask(taskId);
      renaming?.assertFree(task.repoId);
      if (delivering.has(taskId)) {
        throw new TaskStateError(`Task ${taskId} is delivering; it cannot be deleted now`);
      }
      if (commenting.has(taskId)) {
        throw new TaskStateError(
          `Task ${taskId} is commenting on its issue; it cannot be deleted now`,
        );
      }
      const delivered = hasDelivered(task);
      ci?.cancel(taskId);
      await stop(taskId);
      // A gate answer may have queued it again meanwhile.
      scheduler.dequeue(taskId);
      pending.delete(taskId);
      await drives.get(taskId);
      await cleanups.get(taskId);
      await beforeDelete?.(taskId);
      const settled = getTask(taskId);
      // A repo folder that is gone (say, after an import on another machine) has nothing to remove.
      const repo = r.repos.get(settled.repoId);
      if (settled.worktreeRemovedAt) {
        if (repo && pathExists(repo.path)) {
          await archiveWorkspace
            .forget(settled, delivered ? { keepBranch: true } : undefined)
            .catch((error: unknown) =>
              log(
                `Task ${taskId}: could not clean up its archived worktree: ${errorMessage(error)}`,
              ),
            );
        }
      } else if (settled.worktreePath && repo && pathExists(repo.path)) {
        await removeWorkspace(settled, delivered ? { keepBranch: true } : undefined);
      }
      r.tasks.delete(taskId);
      publish({ type: "task.removed", payload: { taskId } });
    },

    /**
     * Startup recovery: steps and tasks a previous process left running become
     * `interrupted` (the user resumes them), queued tasks are scheduled, and a
     * `delivering` flag left by a delivery cut short is cleared. Archived
     * tasks that still have a worktree (archived before removal existed, or
     * whose removal a restart cut short) have it removed in the background;
     * startup never waits for it, and a failure is retried on the next start.
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
        if (
          task.archivedAt !== null &&
          !task.inRepo &&
          task.worktreePath &&
          task.worktreeRemovedAt === null
        ) {
          startCleanup(task.id);
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

    /**
     * Resolves when no task is running and no autonomous answer or worktree
     * removal after archiving is pending (tests).
     */
    async idle(): Promise<void> {
      while (drives.size > 0 || autopilots.size > 0 || cleanups.size > 0) {
        await Promise.all([...drives.values(), ...autopilots, ...cleanups.values()]);
      }
    },

    /** Ids of running tasks and of tasks waiting for a slot. */
    activeTaskIds: (): string[] => scheduler.activeIds(),
    queuedTaskIds: (): string[] => scheduler.queuedIds(),
  };
}
