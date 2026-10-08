import type { CliStatus } from "@blackwall/shared";
import { Hono } from "hono";

/** Agent CLI presence and versions, detected once at startup. */
export function cliRoutes(clis: () => Promise<CliStatus[]>): Hono {
  const routes = new Hono();
  routes.get("/", async (c) => c.json<CliStatus[]>(await clis()));
  return routes;
}
