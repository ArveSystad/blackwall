import {
  createsDependencyCycle,
  sortBacklog,
  unmetDependencies,
  type Repositories,
  type SettingsService,
} from "@blackwall/core";
import {
  newBacklogItemInputSchema,
  repoBacklogRunnerUpdateSchema,
  reorderBacklogInputSchema,
  updateBacklogItemInputSchema,
  type BacklogItem,
  type BacklogItemView,
  type RepoBacklogRunner,
  type ServerEvent,
  type Task,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";
import { createTaskFromInput, type NewTaskServices, type TaskPipeline } from "./tasks.js";

export interface BacklogRouteStores {
  backlogItems: Repositories["backlogItems"];
  repos: Pick<Repositories["repos"], "get">;
  /** Linked tasks, to tell whether a dependency is done. */
  tasks: Pick<Repositories["tasks"], "get">;
}

/** A repo's backlog runner switch and halt. */
export type BacklogRunnerSettings = Pick<
  SettingsService,
  "repoBacklogRunner" | "setRepoBacklogRunnerEnabled" | "setRepoBacklogHalt"
>;

/** The backlog routes' stores, plus the backlog runner's hooks. */
export interface BacklogRouteOptions extends BacklogRouteStores {
  /** The runner's per-repo state; omit to leave the runner routes out. */
  runner?: BacklogRunnerSettings;
  /** Told about every backlog change besides the clients (the backlog runner). */
  onChanged?: (repoId: string) => void;
}

export interface BacklogRouteServices {
  /** Sends an event to every connected client. */
  broadcast: (event: ServerEvent) => void;
  /** Promotion ("run now"); omit to leave the run route out. */
  pipeline?: Pick<TaskPipeline, "createTask">;
  newTask?: NewTaskServices;
  runner?: BacklogRunnerSettings;
}

export interface BacklogPromotion {
  pipeline: Pick<TaskPipeline, "createTask">;
  newTask: NewTaskServices;
  backlogItems: Pick<Repositories["backlogItems"], "markPromoted">;
  broadcast: (event: ServerEvent) => void;
}

/**
 * Promotes a backlog item: creates a normal queued task from it through the
 * same path as the new task form, links it and announces the change. Used by
 * "Run now" and the backlog runner alike.
 */
export async function promoteBacklogItem(
  item: BacklogItem,
  { pipeline, newTask, backlogItems, broadcast }: BacklogPromotion,
): Promise<Task> {
  const { title, origin, mode, repoId, freeText, agents, triageMode } = item;
  const task = await createTaskFromInput(pipeline, newTask, {
    title,
    origin,
    mode,
    repoId,
    freeText,
    agents,
    triageMode,
  });
  backlogItems.markPromoted(item.id, task.id);
  broadcast({ type: "backlog.changed", payload: { repoId } });
  return task;
}

function badRequest(c: Context, error: { issues: { message: string }[] }) {
  return c.json({ error: error.issues.map((i) => i.message).join("; ") }, 400);
}

/**
 * A repo's backlog, mounted at `/api/repos/:repoId/backlog`. Items wait until
 * promoted; `run` promotes one now through the same path as the new task
 * form. Every change is announced as `backlog.changed` so clients refetch.
 */
export function backlogRoutes(
  { backlogItems, repos, tasks }: BacklogRouteStores,
  { broadcast, pipeline, newTask, runner }: BacklogRouteServices,
): Hono {
  const routes = new Hono();

  const isDone = (taskId: string) => tasks.get(taskId)?.status === "done";
  const changed = (repoId: string) => broadcast({ type: "backlog.changed", payload: { repoId } });

  /** Dependency ids that are not items of the repo; an item cannot be its own. */
  function foreignDependencies(items: BacklogItem[], dependsOn: string[]): string[] {
    const ids = new Set(items.map((i) => i.id));
    return dependsOn.filter((id) => !ids.has(id));
  }

  routes.use("*", async (c, next) => {
    const repoId = c.req.param("repoId") ?? "";
    if (!repos.get(repoId)) return c.json({ error: `Repo ${repoId} not found` }, 404);
    await next();
  });

  if (runner) {
    /** Whether the runner promotes this repo's items, and the failed task that halted it. */
    routes.get("/runner", (c) =>
      c.json<RepoBacklogRunner>(runner.repoBacklogRunner(c.req.param("repoId") ?? "")),
    );

    routes.patch("/runner", async (c) => {
      const repoId = c.req.param("repoId") ?? "";
      const input = repoBacklogRunnerUpdateSchema.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!input.success) return badRequest(c, input.error);
      const state = runner.setRepoBacklogRunnerEnabled(repoId, input.data.enabled);
      changed(repoId);
      return c.json<RepoBacklogRunner>(state);
    });

    /** Clears a halt so the runner moves on with the backlog. */
    routes.post("/runner/resume", (c) => {
      const repoId = c.req.param("repoId") ?? "";
      const state = runner.setRepoBacklogHalt(repoId, null);
      changed(repoId);
      return c.json<RepoBacklogRunner>(state);
    });
  }

  /** The repo's items in pick order, each with the dependencies still holding it back. */
  routes.get("/", (c) => {
    const items = backlogItems.list(c.req.param("repoId"));
    const byId = new Map(items.map((i) => [i.id, i]));
    return c.json<BacklogItemView[]>(
      sortBacklog(items).map((item) => {
        const blockedBy = unmetDependencies(item, byId, isDone);
        return { ...item, blocked: blockedBy.length > 0, blockedBy };
      }),
    );
  });

  routes.post("/", async (c) => {
    const repoId = c.req.param("repoId") ?? "";
    const input = newBacklogItemInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return badRequest(c, input.error);
    const foreign = foreignDependencies(backlogItems.list(repoId), input.data.dependsOn);
    if (foreign.length > 0) {
      return c.json({ error: `Unknown dependencies in this repo: ${foreign.join(", ")}` }, 400);
    }
    const item = backlogItems.insert({ ...input.data, repoId });
    changed(repoId);
    return c.json<BacklogItem>(item, 201);
  });

  /** Sets the manual order; the body lists every item of the repo once. */
  routes.post("/reorder", async (c) => {
    const repoId = c.req.param("repoId") ?? "";
    const input = reorderBacklogInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return badRequest(c, input.error);
    const items = backlogItems.list(repoId);
    const listed = new Set(input.data.ids);
    if (items.length !== listed.size || items.some((i) => !listed.has(i.id))) {
      return c.json({ error: "List every backlog item of the repo exactly once" }, 400);
    }
    backlogItems.reorder(repoId, input.data.ids);
    changed(repoId);
    return c.json<BacklogItem[]>(sortBacklog(backlogItems.list(repoId)));
  });

  /** The repo's item, or undefined (another repo's item counts as missing). */
  function itemOf(c: Context): BacklogItem | undefined {
    const item = backlogItems.get(c.req.param("id") ?? "");
    return item?.repoId === c.req.param("repoId") ? item : undefined;
  }
  const notFound = (c: Context) =>
    c.json({ error: `Backlog item ${c.req.param("id")} not found` }, 404);

  routes.patch("/:id", async (c) => {
    const item = itemOf(c);
    if (!item) return notFound(c);
    if (item.status === "promoted") {
      return c.json({ error: "The item was already promoted to a task" }, 409);
    }
    const input = updateBacklogItemInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return badRequest(c, input.error);
    const { dependsOn } = input.data;
    if (dependsOn) {
      const items = backlogItems.list(item.repoId);
      const foreign = foreignDependencies(items, dependsOn);
      if (foreign.length > 0) {
        return c.json({ error: `Unknown dependencies in this repo: ${foreign.join(", ")}` }, 400);
      }
      if (createsDependencyCycle(items, item.id, dependsOn)) {
        return c.json({ error: "The dependencies would form a cycle" }, 400);
      }
    }
    const updated = backlogItems.update(item.id, input.data);
    changed(item.repoId);
    return c.json<BacklogItem>(updated);
  });

  routes.delete("/:id", (c) => {
    const item = itemOf(c);
    if (!item) return notFound(c);
    backlogItems.delete(item.id);
    changed(item.repoId);
    return c.body(null, 204);
  });

  if (pipeline && newTask) {
    /** Promotes the item now: creates a normal queued task from it and links it. */
    routes.post("/:id/run", async (c) => {
      const item = itemOf(c);
      if (!item) return notFound(c);
      if (item.status === "promoted") {
        return c.json({ error: "The item was already promoted to a task" }, 409);
      }
      const task = await promoteBacklogItem(item, {
        pipeline,
        newTask,
        backlogItems,
        broadcast,
      });
      return c.json<Task>(task, 201);
    });
  }

  return routes;
}
