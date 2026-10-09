import {
  MissingCredentialError,
  type NewTaskValues,
  type PipelineEngine,
  type RepoService,
  type Repositories,
  type TaskDiffs,
} from "@blackwall/core";
import {
  findingOverrideInputSchema,
  gateResponseInputSchema,
  grillAnswerInputSchema,
  MAX_TITLE_CHARS,
  newTaskInputSchema,
  type AgentCli,
  type DeliveryPlan,
  type Finding,
  type GrillAnswerResult,
  type GrillQuestion,
  type RoleAgents,
  type Run,
  type Step,
  type StepEvent,
  type Task,
  type TaskDiff,
  type TaskOrigin,
} from "@blackwall/shared";
import { Hono } from "hono";

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
  /** The role defaults of `cli` with the form's choices on top. */
  resolveRoles: (overrides?: RoleAgents, cli?: AgentCli) => RoleAgents;
  /** The Jira issue's summary or the PR's title; undefined when the origin has none. */
  originTitle?: (origin: TaskOrigin) => Promise<string | undefined>;
}

export interface TaskRouteServices {
  newTask?: NewTaskServices;
  /** Per-round diffs of a task's branch. */
  diffs?: TaskDiffs;
}

/**
 * Title for a task the form gave none and the origin could not name: a free
 * text task's first line, otherwise the Jira key or `owner/repo#number`.
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
 * A task's title from its origin: the Jira issue's summary or the PR's title,
 * otherwise {@link fallbackTitle}. A missing token still throws.
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

/** A parsed new task form: what `POST /api/tasks` and backlog promotion both start from. */
export type ParsedNewTaskInput = Omit<NewTaskValues, "title"> & { title?: string | undefined };

/**
 * Creates and queues a task: checks the repo is usable, puts the form's
 * agents on top of the repo's CLI's role defaults and, without a title, uses the Jira
 * issue's summary, the PR's title or a fallback.
 */
export async function createTaskFromInput(
  pipeline: Pick<TaskPipeline, "createTask">,
  newTask: NewTaskServices,
  input: ParsedNewTaskInput,
): Promise<Task> {
  const { origin, freeText } = input;
  newTask.repos.use(input.repoId);
  const title = input.title ?? (await titleFor(origin, freeText, newTask.originTitle));
  return queueTask(pipeline, newTask, { ...input, title });
}

/**
 * Queues a titled task without awaiting anything: checks the repo is usable
 * and puts the given agents on top of the repo's CLI's role defaults.
 */
export function queueTask(
  pipeline: Pick<TaskPipeline, "createTask">,
  newTask: NewTaskServices,
  input: NewTaskValues,
): Task {
  const { title, origin, mode, repoId, freeText, triageMode } = input;
  const repo = newTask.repos.use(repoId);
  const agents = newTask.resolveRoles(input.agents, repo.defaultCli);
  return pipeline.createTask({ title, origin, mode, repoId, freeText, agents, triageMode });
}

/**
 * Task routes. Tasks change through the pipeline and reach clients as WS
 * events; with a pipeline, interrupted or failed tasks can be resumed, done
 * tasks archived and unarchived, a queued or running task stopped, an
 * undelivered task deleted, a
 * `needs-you` task's gate answered, its grill questions answered, its
 * findings force-fixed or force-ignored, and its delivery plan shown before
 * the user confirms the finish actions.
 */
export function taskRoutes(
  { tasks, grillQuestions, findings, runs, steps, stepEvents }: TaskRouteStores,
  pipeline?: TaskPipeline,
  { newTask, diffs }: TaskRouteServices = {},
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
      return c.json<Task>(await createTaskFromInput(pipeline, newTask, input.data), 201);
    });
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
      return c.json<TaskDiff[]>(await diffs(task));
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

    /** Force-fixes or force-ignores a finding, at any time; it applies from the next round. */
    routes.post("/:id/findings/:findingId", async (c) => {
      const input = findingOverrideInputSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!input.success) {
        return c.json({ error: input.error.issues.map((i) => i.message).join("; ") }, 400);
      }
      const { id, findingId } = c.req.param();
      return c.json<Finding>(pipeline.overrideFinding(id, findingId, input.data));
    });
  }

  return routes;
}
