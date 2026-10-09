import type { QuotaTracker } from "@blackwall/core";
import type { QuotaState } from "@blackwall/shared";
import { Hono } from "hono";

/** Read-only usage-limit state per agent CLI; changes arrive as `quota.changed`. */
export function quotaRoutes(quota: Pick<QuotaTracker, "state">): Hono {
  const routes = new Hono();
  routes.get("/", (c) => c.json<QuotaState[]>(quota.state()));
  return routes;
}
