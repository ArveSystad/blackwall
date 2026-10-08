import type { PipelineEngine, Repositories } from "@blackwall/core";
import {
  findingOverrideInputSchema,
  gateResponseInputSchema,
  grillAnswerInputSchema,
  type Finding,
  type GrillAnswerResult,
  type GrillQuestion,
  type Task,
} from "@blackwall/shared";
import { Hono } from "hono";

/** The engine actions the task routes expose. */
export type TaskPipeline = Pick<
  PipelineEngine,
  "resume" | "respond" | "answerQuestion" | "overrideFinding"
>;

export interface TaskRouteStores {
  tasks: Repositories["tasks"];
  grillQuestions: Repositories["grillQuestions"];
  findings: Repositories["findings"];
}

/**
 * Task routes. Tasks change through the pipeline and reach clients as WS
 * events; with a pipeline, interrupted or failed tasks can be resumed, a
 * `needs-you` task's gate answered, its grill questions answered and its
 * findings force-fixed or force-ignored.
 */
export function taskRoutes(
  { tasks, grillQuestions, findings }: TaskRouteStores,
  pipeline?: TaskPipeline,
): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<Task[]>(tasks.list()));

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

  if (pipeline) {
    /** Re-queues an interrupted or failed task; interrupted steps resume their CLI sessions. */
    routes.post("/:id/resume", (c) => c.json<Task>(pipeline.resume(c.req.param("id"))));

    /** Answers the gate the task waits on (plan approval, escalation, finish, …). */
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
