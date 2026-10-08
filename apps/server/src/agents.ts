import type { AgentService } from "@blackwall/core";
import {
  agentInputSchema,
  agentUpdateSchema,
  roleAgentsSchema,
  type Agent,
  type RoleAgents,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";

function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

function badRequest(c: Context, issues: readonly { message: string }[]) {
  return c.json({ error: issues.map((issue) => issue.message).join("; ") }, 400);
}

/** Agent library routes, plus the default agent per pipeline role. */
export function agentRoutes(agents: AgentService): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<Agent[]>(agents.list()));

  routes.post("/", async (c) => {
    const input = agentInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<Agent>(agents.create(input.data), 201);
  });

  routes.get("/role-defaults", (c) => c.json<RoleAgents>(agents.roleDefaults()));

  /** Replaces the role defaults; each agent must exist and be eligible for its role's stage. */
  routes.put("/role-defaults", async (c) => {
    const input = roleAgentsSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<RoleAgents>(agents.setRoleDefaults(input.data));
  });

  routes.get("/:id", (c) => c.json<Agent>(agents.get(c.req.param("id"))));

  routes.patch("/:id", async (c) => {
    const patch = agentUpdateSchema.safeParse(await body(c));
    if (!patch.success) return badRequest(c, patch.error.issues);
    return c.json<Agent>(agents.update(c.req.param("id"), patch.data));
  });

  routes.delete("/:id", (c) => {
    agents.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return routes;
}
