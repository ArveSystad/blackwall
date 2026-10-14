import { existsSync } from "node:fs";
import {
  DeliveryError,
  InvalidGateResponseError,
  MissingCredentialError,
  type NewTaskValues,
  type PipelineEngine,
  type RepoService,
  type Repositories,
  type TaskArtifacts,
  type TaskBranchDiff,
  type TaskDiffs,
} from "@blackwall/core";
import type { PullRequestStackMember } from "@blackwall/integrations";
import {
  diffCommentsInputSchema,
  findingOverrideInputSchema,
  gateResponseInputSchema,
  grillAnswerInputSchema,
  MAX_TITLE_CHARS,
  newTaskInputSchema,
  type ActiveAgentStep,
  type AgentCli,
  type AgentClis,
  type BranchDiff,
  type DeliveryPlan,
  type DiffCommentsResult,
  type Finding,
  type FindingDeleteResult,
  type GrillAnswerResult,
  type GrillQuestion,
  type RoleAgents,
  type Run,
  type Step,
  type StepEvent,
  type StepUsage,
  type Task,
  type TaskArtifact,
  type TaskDiff,
  type TaskDoneTime,
  type TaskOrigin,
  type TaskWorktree,
} from "@blackwall/shared";
import { Hono } from "hono";
import { withoutStack } from "./backlog.js";

/** The engine actions the task routes expose. */
export type TaskPipeline = Pick<
  PipelineEngine,
  | "createTask"
  | "resume"
  | "archive"
  | "unarchive"
  | "stop"
  | "delete"
  | "respond"
  | "answerQuestion"
  | "overrideFinding"
  | "commentOnDiff"
  | "deleteFinding"
  | "deliveryPlan"
>;

export interface TaskRouteStores {
  tasks: Repositories["tasks"];
  grillQuestions: Repositories["grillQuestions"];
  findings: Repositories["findings"];
  /** Runs, steps and their event logs, for the agent output and checks views. */
  runs?: Repositories["runs"];
  steps?: Repositories["steps"];
  stepEvents?: Repositories["stepEvents"];
}

/** What creating a task needs besides the pipeline. */
export interface NewTaskServices {
  repos: Pick<RepoService, "use">;
  /** The role defaults with the form's choices on top. */
  resolveRoles: (overrides?: RoleAgents) => RoleAgents;
  /** The form's per-agent CLI choices for agents in `roles` that differ from `cli`. */
  resolveClis: (roles: RoleAgents, agentClis: AgentClis, cli: AgentCli) => AgentClis;
  /** The Jira issue's summary or the PR's or GitHub issue's title; undefined when the origin has none. */
  originTitle?: (origin: TaskOrigin) => Promise<string | undefined>;
  /** Posts a comment the user confirmed on a GitHub issue, for the start comment. */
  commentOnIssue?: (origin: GitHubIssueOrigin, body: string) => Promise<{ url: string }>;
  /** Assigns a GitHub issue to the token's user, for `assignToMe`. */
  assignIssue?: (origin: GitHubIssueOrigin) => Promise<unknown>;
  /**
   * The open PRs of the stack a PR belongs to, bottom first; undefined when it
   * is not stacked. A new backlog PR item adds Review PR items for the others.
   */
  pullRequestStack?: (origin: GitHubPrOrigin) => Promise<PullRequestStackMember[] | undefined>;
}

type GitHubIssueOrigin = Extract<TaskOrigin, { kind: "github-issue" }>;
type GitHubPrOrigin = Extract<TaskOrigin, { kind: "github-pr" }>;

export interface TaskRouteServices {
  newTask?: NewTaskServices;
  /** Per-round diffs of a task's branch. */
  diffs?: TaskDiffs;
  /** The whole diff of a task's branch, for commenting on its hunks. */
  branchDiff?: TaskBranchDiff;
  /** Images implementers saved to a task's worktree. */
  artifacts?: TaskArtifacts;
}

/** The task had a worktree that is gone, e.g. after an import on another machine. */
const worktreeMissing = (task: Task) =>
  task.worktreePath !== null && !existsSync(task.worktreePath);

/**
 * Title for a task the form gave none and the origin could not name: a free
 * text task's first line, otherwise the Jira key or `owner/repo#number` of the
 * PR or GitHub issue.
 */
export function fallbackTitle(origin: TaskOrigin, freeText: string): string {
  if (origin.kind === "free-text") {
    const line = freeText.trim().split("\n")[0]?.trim() || "Untitled task";
    return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
  }
  return origin.kind === "jira-issue"
    ? origin.key
    : `${origin.owner}/${origin.repo}#${origin.number}`;
}

/**
 * A task's title from its origin: the Jira issue's summary or the PR's or
 * GitHub issue's title, otherwise {@link fallbackTitle}. A missing token still throws.
 */
export async function titleFor(
  origin: TaskOrigin,
  freeText: string,
  originTitle: NewTaskServices["originTitle"],
): Promise<string> {
  if (origin.kind !== "free-text" && originTitle) {
    try {
      const title = (await originTitle(origin))?.trim();
      if (title) return title.slice(0, MAX_TITLE_CHARS);
    } catch (error) {
      // A missing token opens the token modal; other lookup failures fall back.
      if (error instanceof MissingCredentialError) throw error;
    }
  }
  return fallbackTitle(origin, freeText);
}

/** A titled task as the form describes it; its CLI comes from the repo when it is queued. */
export type QueuedTaskInput = Omit<NewTaskValues, "cli">;

/** A parsed new task form: what `POST /api/tasks` and backlog promotion both start from. */
export type ParsedNewTaskInput = Omit<QueuedTaskInput, "title"> & {
  title?: string | undefined;
  /** GitHub issue tasks: a comment the user confirmed, posted when the task is created. */
  startComment?: { body: string } | undefined;
  /** GitHub issue tasks: assign the issue to the token's user when the task is created. */
  assignToMe?: boolean | undefined;
};

/**
 * Creates and queues a task: checks the repo is usable, puts the form's
 * agents on top of the role defaults and, without a title, uses the Jira
 * issue's summary, the PR's or GitHub issue's title, or a fallback. A GitHub
 * issue task's confirmed start comment is posted before the task exists, so
 * a failed post creates nothing and a retry leaves no duplicate task. With
 * `assignToMe` the issue is assigned to the user the same way, before the
 * task exists; assigning again on a retry is harmless.
 */
export async function createTaskFromInput(
  pipeline: Pick<TaskPipeline, "createTask">,
  newTask: NewTaskServices,
  input: ParsedNewTaskInput,
): Promise<Task> {
  const { origin, freeText, startComment, assignToMe } = input;
  newTask.repos.use(input.repoId);
  const title = input.title ?? (await titleFor(origin, freeText, newTask.originTitle));
  if (startComment) await postStartComment(newTask, origin, startComment);
  if (assignToMe) await assignIssueToUser(newTask, origin);
  return queueTask(pipeline, newTask, { ...input, title });
}

/**
 * Posts the start comment the user confirmed on a GitHub issue task's issue.
 * A missing token surfaces as is (the token modal asks for one); other
 * failures carry the host's own message.
 */
export async function postStartComment(
  newTask: Pick<NewTaskServices, "commentOnIssue">,
  origin: TaskOrigin,
  { body }: { body: string },
): Promise<void> {
  if (origin.kind !== "github-issue") {
    throw new InvalidGateResponseError("Only GitHub issue tasks comment when work starts");
  }
  if (!newTask.commentOnIssue) throw new Error("Commenting on GitHub issues is not set up");
  try {
    await newTask.commentOnIssue(origin, body);
  } catch (error) {
    if (error instanceof MissingCredentialError) throw error;
    throw new DeliveryError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Assigns a GitHub issue task's issue to the token's user. A missing token
 * surfaces as is (the token modal asks for one); other failures carry the
 * host's own message.
 */
export async function assignIssueToUser(
  newTask: Pick<NewTaskServices, "assignIssue">,
  origin: TaskOrigin,
): Promise<void> {
  if (origin.kind !== "github-issue") {
    throw new InvalidGateResponseError("Only GitHub issue tasks can be assigned");
  }
  if (!newTask.assignIssue) throw new Error("Assigning GitHub issues is not set up");
  try {
    await newTask.assignIssue(origin);
  } catch (error) {
    if (error instanceof MissingCredentialError) throw error;
    throw new DeliveryError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Queues a titled task without awaiting anything: checks the repo is usable,
 * puts the given agents on top of the role defaults, and runs them on the
 * repo's default CLI except where the input chose another one.
 */
export function queueTask(
  pipeline: Pick<TaskPipeline, "createTask">,
  newTask: NewTaskServices,
  input: QueuedTaskInput,
): Task {
  const { title, origin, mode, repoId, freeText, triageMode } = input;
  const repo = newTask.repos.use(repoId);
  const agents = newTask.resolveRoles(input.agents);
  const cli = repo.defaultCli;
  const agentClis = newTask.resolveClis(agents, input.agentClis, cli);
  return pipeline.createTask({
    title,
    origin,
    mode,
    repoId,
    freeText,
    agents,
    cli,
    agentClis,
    triageMode,
  });
}

/**
 * Task routes. Tasks change through the pipeline and reach clients as WS
 * events; with a pipeline, interrupted or failed tasks can be resumed, done
 * tasks archived and unarchived, a queued or running task stopped, an
 * undelivered task deleted, a
 * `needs-you` task's gate answered, its grill questions answered, its
 * findings force-fixed or force-ignored (or, at review triage, deleted), its
 * diff's hunks commented on, and
 * its delivery plan shown before the user confirms the finish actions. `/active-agents` lists the running
 * agent steps across all tasks, `/usage` each agent step's tokens and cost, and
 * `/done-times` when each done task was resolved. With the services, `/diffs` shows the branch's changes per fix
 * round, `/branch-diff` the whole branch's diff to comment on, and
 * `/artifacts` lists and serves the images an implementer saved.
 */
export function taskRoutes(
  { tasks, grillQuestions, findings, runs, steps, stepEvents }: TaskRouteStores,
  pipeline?: TaskPipeline,
  { newTask, diffs, branchDiff, artifacts }: TaskRouteServices = {},
): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<Task[]>(tasks.list()));

  if (pipeline && newTask) {
    /**
     * Creates a task from the new task form and queues it. The agents are the
     * role defaults with the form's choices on top; without a title, the
     * Jira issue's summary or the PR's title is used.
     */
    routes.post("/", async (c) => {
      const input = newTaskInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      // Only the server links a PR to its stack.
      const values = { ...input.data, origin: withoutStack(input.data.origin) };
      return c.json<Task>(await createTaskFromInput(pipeline, newTask, values), 201);
    });
  }

  if (steps) {
    /** Every running agent step with its task, oldest first. Must stay above `/:id`, which would catch it. */
    routes.get("/active-agents", (c) => c.json<ActiveAgentStep[]>(steps.listActiveAgents()));
    /** Each agent step's tokens and cost with its task, for the task header and stats view. Must stay above `/:id`. */
    routes.get("/usage", (c) => c.json<StepUsage[]>(steps.usage()));
  }

  if (runs) {
    /** When each done task was resolved, for the stats view. Must stay above `/:id`, which would catch it. */
    routes.get("/done-times", (c) => c.json<TaskDoneTime[]>(runs.doneTimes()));
  }

  routes.get("/:id", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    return task ? c.json<Task>(task) : c.json({ error: `Task ${id} not found` }, 404);
  });

  /** The plan reviewers' questions and their answers; `needsHuman` ones without an answer wait on the user. */
  routes.get("/:id/questions", (c) => {
    const id = c.req.param("id");
    if (!tasks.get(id)) return c.json({ error: `Task ${id} not found` }, 404);
    return c.json<GrillQuestion[]>(grillQuestions.listByTask(id));
  });

  /** The review findings, merged duplicates included (`status: "merged"`, `mergedIntoId`). */
  routes.get("/:id/findings", (c) => {
    const id = c.req.param("id");
    if (!tasks.get(id)) return c.json({ error: `Task ${id} not found` }, 404);
    return c.json<Finding[]>(findings.listByTask(id));
  });

  /** Where the task's worktree is and whether it exists; it may be missing after an import. */
  routes.get("/:id/worktree", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    if (!task) return c.json({ error: `Task ${id} not found` }, 404);
    const path = task.worktreePath;
    return c.json<TaskWorktree>({ path, exists: path !== null && existsSync(path) });
  });

  if (runs && steps && stepEvents) {
    /** The task's pipeline runs, oldest first. */
    routes.get("/:id/runs", (c) => {
      const id = c.req.param("id");
      if (!tasks.get(id)) return c.json({ error: `Task ${id} not found` }, 404);
      return c.json<Run[]>(runs.listByTask(id));
    });

    /** A run's steps (agent and harness invocations), in order. */
    routes.get("/:id/runs/:runId/steps", (c) => {
      const { id, runId } = c.req.param();
      const run = runs.get(runId);
      if (!run || run.taskId !== id) return c.json({ error: `Run ${runId} not found` }, 404);
      return c.json<Step[]>(steps.listByRun(runId));
    });

    /** A step's event log: agent messages and tool calls, or check commands and their output. */
    routes.get("/:id/steps/:stepId/events", (c) => {
      const { id, stepId } = c.req.param();
      const step = steps.get(stepId);
      const run = step && runs.get(step.runId);
      if (!step || !run || run.taskId !== id) {
        return c.json({ error: `Step ${stepId} not found` }, 404);
      }
      return c.json<StepEvent[]>(stepEvents.list(stepId));
    });
  }

  if (diffs) {
    /** The branch's changes per fix round, plus commits not reviewed yet. */
    routes.get("/:id/diffs", async (c) => {
      const id = c.req.param("id");
      const task = tasks.get(id);
      if (!task) return c.json({ error: `Task ${id} not found` }, 404);
      if (worktreeMissing(task)) return c.json<TaskDiff[]>([]);
      return c.json<TaskDiff[]>(await diffs(task));
    });
  }

  if (branchDiff) {
    /** The branch's whole diff from its fork point to HEAD; null before it has commits. */
    routes.get("/:id/branch-diff", async (c) => {
      const id = c.req.param("id");
      const task = tasks.get(id);
      if (!task) return c.json({ error: `Task ${id} not found` }, 404);
      if (worktreeMissing(task)) return c.json<BranchDiff | null>(null);
      return c.json<BranchDiff | null>(await branchDiff(task));
    });
  }

  if (artifacts) {
    /** The images saved to `.blackwall/artifacts/` in the task's worktree, newest first. */
    routes.get("/:id/artifacts", async (c) => {
      const id = c.req.param("id");
      const task = tasks.get(id);
      if (!task) return c.json({ error: `Task ${id} not found` }, 404);
      return c.json<TaskArtifact[]>(await artifacts.list(task));
    });

    /** One artifact's bytes; untrusted, so with a fixed image type and `nosniff`. */
    routes.get("/:id/artifacts/:path{.+}", async (c) => {
      const id = c.req.param("id");
      const task = tasks.get(id);
      if (!task) return c.json({ error: `Task ${id} not found` }, 404);
      const path = c.req.param("path");
      const file = await artifacts.read(task, path);
      if (!file) return c.json({ error: `Artifact ${path} not found` }, 404);
      return c.body(new Uint8Array(file.body), 200, {
        "Content-Type": file.contentType,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
    });
  }

  if (pipeline) {
    /** Re-queues an interrupted or failed task; interrupted steps resume their CLI sessions. */
    routes.post("/:id/resume", (c) => c.json<Task>(pipeline.resume(c.req.param("id"))));

    /** Archives a done task (409 otherwise): it leaves the Inbox and the backlog lists. */
    routes.post("/:id/archive", (c) => c.json<Task>(pipeline.archive(c.req.param("id"))));

    /** Lists an archived task again. */
    routes.post("/:id/unarchive", (c) => c.json<Task>(pipeline.unarchive(c.req.param("id"))));

    /**
     * Stops a queued or running task: it ends `interrupted` ("Stopped by
     * you"), its agent CLIs killed, and Resume continues the same session.
     */
    routes.post("/:id/stop", async (c) => c.json<Task>(await pipeline.stop(c.req.param("id"))));

    /**
     * Deletes a task with its worktree, local branch (kept for PR tasks) and
     * history; 409 once delivery has started or finished.
     */
    routes.delete("/:id", async (c) => {
      await pipeline.delete(c.req.param("id"));
      return c.body(null, 204);
    });

    /**
     * What finishing would do: each delivery action with its exact target
     * (branch and remote, PR, Jira issue, comment text), the optional squash,
     * and actions a failed attempt already performed.
     */
    routes.get("/:id/delivery", async (c) =>
      c.json<DeliveryPlan>(await pipeline.deliveryPlan(c.req.param("id"))),
    );

    /**
     * Answers the gate the task waits on (plan approval, escalation, finish, …).
     * Approving finish (or a Review PR task's triage) performs only the
     * delivery actions listed in `delivery`.
     */
    routes.post("/:id/gate", async (c) => {
      const input = gateResponseInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      return c.json<Task>(await pipeline.respond(c.req.param("id"), input.data));
    });

    /** Answers a grill question only the user can decide; the last answer continues the task. */
    routes.post("/:id/questions/:questionId/answer", async (c) => {
      const input = grillAnswerInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      const { id, questionId } = c.req.param();
      return c.json<GrillAnswerResult>(await pipeline.answerQuestion(id, questionId, input.data));
    });

    /** Force-fixes or force-ignores a finding, at any time; it applies from the next round, and at the finish gate a force-fix starts the fix round. */
    routes.post("/:id/findings/:findingId", async (c) => {
      const input = findingOverrideInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      const { id, findingId } = c.req.param();
      return c.json<Finding>(pipeline.overrideFinding(id, findingId, input.data));
    });

    /** Deletes a finding, with the duplicates merged into it, while a review task waits at triage. */
    routes.delete("/:id/findings/:findingId", (c) => {
      const { id, findingId } = c.req.param();
      return c.json<FindingDeleteResult>(pipeline.deleteFinding(id, findingId));
    });

    /**
     * The user's comments on hunks of the branch diff, as findings: force-fixed
     * in a work task, where at the finish or escalation gate they start a fix
     * round straight away, and open in a review task, to post to the PR.
     */
    routes.post("/:id/comments", async (c) => {
      const input = diffCommentsInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      return c.json<DiffCommentsResult>(pipeline.commentOnDiff(c.req.param("id"), input.data));
    });
  }

  return routes;
}
