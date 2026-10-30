import type { ProjectRuns } from "@blackwall/core";
import type { ProjectRun, ProjectRunOutput } from "@blackwall/shared";
import { Hono } from "hono";

/**
 * Run project, mounted at `/api/repos/:repoId/run`. `POST /` starts the repo's
 * run commands (202 with the run; 400 without run commands or folder, 409
 * while a run is active), `DELETE /` stops them (204, also when nothing runs)
 * and `GET /output` returns the tail of the latest run's output, or null.
 * Changes reach clients as `projectRun.*` events.
 */
export function projectRunRoutes(runs: Pick<ProjectRuns, "start" | "stop" | "output">): Hono {
  const routes = new Hono();

  routes.post("/", (c) => c.json<ProjectRun>(runs.start(c.req.param("repoId") ?? ""), 202));

  routes.delete("/", async (c) => {
    await runs.stop(c.req.param("repoId") ?? "");
    return c.body(null, 204);
  });

  routes.get("/output", (c) =>
    c.json<ProjectRunOutput | null>(runs.output(c.req.param("repoId") ?? "")),
  );

  return routes;
}

/** `GET /api/project-runs`: every repo's latest run, mounted at `/api/project-runs`. */
export function projectRunListRoutes(runs: Pick<ProjectRuns, "list">): Hono {
  const routes = new Hono();
  routes.get("/", (c) => c.json<ProjectRun[]>(runs.list()));
  return routes;
}
