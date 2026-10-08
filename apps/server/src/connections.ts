import type { ConnectionService } from "@blackwall/core";
import {
  connectionInputSchema,
  connectionUpdateSchema,
  resolveConnectionInputSchema,
  tokenInputSchema,
  type Connection,
  type ConnectionTestResult,
  type ConnectionView,
} from "@blackwall/shared";
import { Hono, type Context } from "hono";

/** Runs a connection's "Test connection" request (see `@blackwall/integrations`). */
export type ConnectionTester = (
  connection: Connection,
  token: string,
) => Promise<ConnectionTestResult>;

export interface ConnectionRoutesOptions {
  connections: ConnectionService;
  test: ConnectionTester;
}

function body(c: Context): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

function badRequest(c: Context, issues: readonly { message: string }[]) {
  return c.json({ error: issues.map((issue) => issue.message).join("; ") }, 400);
}

/**
 * Connection routes. Responses carry `ConnectionView`s (`hasToken` only); a token
 * goes into the keychain and never comes back out through the API. An action on
 * a host without a connection or token throws `MissingCredentialError`, which the
 * app's error handler turns into a `MissingCredential` response.
 */
export function connectionRoutes({ connections, test }: ConnectionRoutesOptions): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<ConnectionView[]>(connections.list()));

  routes.post("/", async (c) => {
    const input = connectionInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    return c.json<ConnectionView>(await connections.create(input.data), 201);
  });

  /** Finds the connection for a git remote or Jira URL and checks that it has a token. */
  routes.post("/resolve", async (c) => {
    const input = resolveConnectionInputSchema.safeParse(await body(c));
    if (!input.success) return badRequest(c, input.error.issues);
    const { connection } = await connections.requireCredential(input.data);
    return c.json<ConnectionView>(connections.get(connection.id));
  });

  routes.get("/:id", (c) => c.json<ConnectionView>(connections.get(c.req.param("id"))));

  routes.patch("/:id", async (c) => {
    const patch = connectionUpdateSchema.safeParse(await body(c));
    if (!patch.success) return badRequest(c, patch.error.issues);
    return c.json<ConnectionView>(connections.update(c.req.param("id"), patch.data));
  });

  routes.delete("/:id", async (c) => {
    await connections.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  routes.post("/:id/test", async (c) => {
    const { connection, token } = await connections.credentialById(c.req.param("id"));
    return c.json<ConnectionTestResult>(await test(connection, token));
  });

  routes.put("/:id/token", async (c) => {
    const input = tokenInputSchema.safeParse(await body(c));
    if (!input.success) return c.json({ error: "token is required" }, 400);
    return c.json<ConnectionView>(await connections.setToken(c.req.param("id"), input.data.token));
  });

  routes.delete("/:id/token", async (c) =>
    c.json<ConnectionView>(await connections.deleteToken(c.req.param("id"))),
  );

  return routes;
}
