import type { ChatService } from "@blackwall/core";
import { chatSendInputSchema } from "@blackwall/shared";
import { Hono } from "hono";

/** The chat service as the routes use it. */
export type ChatRouteService = Pick<ChatService, "get" | "send" | "markApplied">;

/**
 * A repo's chat, mounted at `/api/repos/:repoId/chat`. A message is answered
 * in the background (202); progress and the answer arrive as `chat.upserted`.
 * A message while the chat answers is refused (409) unless it is `/clear`.
 */
export function chatRoutes(chat: ChatRouteService): Hono {
  const routes = new Hono();

  routes.get("/", (c) => c.json(chat.get(c.req.param("repoId") ?? "")));

  routes.post("/", async (c) => {
    const parsed = chatSendInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    return c.json(chat.send(c.req.param("repoId") ?? "", parsed.data.text), 202);
  });

  routes.post("/actions/:actionId/applied", (c) =>
    c.json(chat.markApplied(c.req.param("repoId") ?? "", c.req.param("actionId"))),
  );

  return routes;
}
