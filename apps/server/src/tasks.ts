import type { PipelineEngine, Repositories } from "@blackwall/core";
import {
  gateResponseInputSchema,
  grillAnswerInputSchema,
  type GrillAnswerResult,
  type GrillQuestion,
  type Task,
} from "@blackwall/shared";
import { Hono } from "hono";

/** The engine actions the task routes expose. */
export type TaskPipeline = Pick<PipelineEngine, "resume" | "respond" | "answerQuestion">;

export interface TaskRouteStores {
  tasks: Repositories["tasks"];
  grillQuestions: Repositories["grillQuestions"];
}

/**
 * Task routes. Tasks change through the pipeline and reach clients as WS
 * events; with a pipeline, interrupted or failed tasks can be resumed, a
 * `needs-you` task's gate answered and its grill questions answered.
 */
export function taskRoutes(
  { tasks, grillQuestions }: TaskRouteStores,
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
  }

  return routes;
}
