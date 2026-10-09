import type { RepoService } from "@blackwall/core";
import {
  reorderReposInputSchema,
  repoInputSchema,
  repoScanInputSchema,
  repoUpdateSchema,
  type Repo,
  type RepoScanResult,
  type RepoView,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";

function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

function badRequest(c: Context, issues: readonly { message: string }[]) {
  return c.json({ error: issues.map((issue) => issue.message).join("; ") }, 400);
}

/**
 * Repo registry routes. Using a repo whose folder is gone throws
 * `StaleRepoError`, which the app's error handler turns into a `StaleRepo`
 * warning response after the repo has been removed from the registry.
 */
export function repoRoutes(repos: RepoService): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<RepoView[]>(repos.list()));

  routes.post("/", async (c) => {
    const input = repoInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<Repo>(await repos.add(input.data), 201);
  });

  /** Registers every git repo under a root folder. */
  routes.post("/scan", async (c) => {
    const input = repoScanInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<RepoScanResult>(await repos.scan(input.data));
  });

  /** Sets the manual order; the body lists every repo id exactly once. */
  routes.post("/reorder", async (c) => {
    const input = reorderReposInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<RepoView[]>(repos.reorder(input.data.ids));
  });

  routes.get("/:id", (c) => c.json<Repo>(repos.get(c.req.param("id"))));

  routes.patch("/:id", async (c) => {
    const patch = repoUpdateSchema.safeParse(await body(c));
    if (!patch.success) return badRequest(c, patch.error.issues);
    return c.json<Repo>(repos.update(c.req.param("id"), patch.data));
  });

  routes.delete("/:id", (c) => {
    repos.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  /** Re-reads the origin remote and its connection; a missing folder is a `StaleRepo`. */
  routes.post("/:id/refresh", async (c) => c.json<Repo>(await repos.refresh(c.req.param("id"))));

  /** Check commands suggested from the repo's build files, for "reset to suggested". */
  routes.get("/:id/suggested-checks", async (c) =>
    c.json<string[]>(await repos.suggestChecks(c.req.param("id"))),
  );

  return routes;
}
