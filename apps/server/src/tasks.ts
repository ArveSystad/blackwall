import type { Repositories } from "@blackwall/core";
import type { Task } from "@blackwall/shared";
import { Hono } from "hono";

/** Read-only task routes; tasks change through the pipeline and reach clients as WS events. */
export function taskRoutes(tasks: Repositories["tasks"]): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<Task[]>(tasks.list()));

  routes.get("/:id", (c) => {
    const id = c.req.param("id");
    const task = tasks.get(id);
    return task ? c.json<Task>(task) : c.json({ error: `Task ${id} not found` }, 404);
  });

  return routes;
}
