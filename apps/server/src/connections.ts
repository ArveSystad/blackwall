import { ConnectionNotFoundError, SecretStoreError, type ConnectionTokens } from "@blackwall/core";
import { tokenInputSchema, type ConnectionView } from "@blackwall/shared";
import { Hono, type Context } from "hono";

function failure(c: Context, error: unknown) {
  if (error instanceof ConnectionNotFoundError) return c.json({ error: error.message }, 404);
  if (error instanceof SecretStoreError) {
    // The message names the connection id only; the cause is not logged.
    console.error(error.message);
    return c.json({ error: "OS keychain unavailable" }, 503);
  }
  throw error;
}

/**
 * Connection routes. Responses carry `ConnectionView`s (`hasToken` only); a token
 * goes into the keychain and never comes back out through the API.
 */
export function connectionRoutes(tokens: ConnectionTokens): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json<ConnectionView[]>(tokens.list()));

  routes.put("/:id/token", async (c) => {
    const body = tokenInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json({ error: "token is required" }, 400);
    try {
      return c.json<ConnectionView>(await tokens.set(c.req.param("id"), body.data.token));
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.delete("/:id/token", async (c) => {
    try {
      return c.json<ConnectionView>(await tokens.delete(c.req.param("id")));
    } catch (error) {
      return failure(c, error);
    }
  });

  return routes;
}
