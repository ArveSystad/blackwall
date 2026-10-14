import type { ChatService } from "@blackwall/core";
import { chatActionProposalSchema, chatSendInputSchema } from "@blackwall/shared";
import { Hono } from "hono";

/** The chat service as the routes use it. */
export type ChatRouteService = Pick<ChatService, "get" | "send" | "markApplied" | "addAction">;

/**
 * A repo's chat, mounted at `/api/repos/:repoId/chat`. A message is answered
 * in the background (202); progress and the answer arrive as `chat.upserted`.
 * A message while the chat answers is refused (409) unless it is `/clear`.
 * The user can add an action to an assistant message, e.g. to turn a reply
 * into a task.
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

  routes.post("/messages/:messageId/actions", async (c) => {
    const parsed = chatActionProposalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    return c.json(
      chat.addAction(c.req.param("repoId") ?? "", c.req.param("messageId"), parsed.data),
    );
  });

  return routes;
}
