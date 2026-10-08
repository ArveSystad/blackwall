import type { PipelineEngine, Repositories } from "@blackwall/core";
import { gateResponseInputSchema, type Task } from "@blackwall/shared";
import { Hono } from "hono";

/** The engine actions the task routes expose. */
export type TaskPipeline = Pick<PipelineEngine, "resume" | "respond">;

/**
 * Task routes. Tasks change through the pipeline and reach clients as WS
 * events; with a pipeline, interrupted or failed tasks can be resumed and a
 * `needs-you` task's gate answered.
 */
export function taskRoutes(tasks: Repositories["tasks"], pipeline?: TaskPipeline): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<Task[]>(tasks.list()));

  routes.get("/:id", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    return task ? c.json<Task>(task) : c.json({ error: `Task ${id} not found` }, 404);
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
  }

  return routes;
}
