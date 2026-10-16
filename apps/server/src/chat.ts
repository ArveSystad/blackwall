import type { ChatService } from "@blackwall/core";
import { chatActionProposalSchema, chatSendInputSchema } from "@blackwall/shared";
import { Hono, type Context } from "hono";

/** The chat service as the routes use it. */
export type ChatRouteService = Pick<ChatService, "get" | "send" | "markApplied" | "addAction">;

/**
 * A chat conversation, mounted twice: at `/api/repos/:repoId/chat` for the
 * repo's chat and at `/api/repos/:repoId/tasks/:taskId/chat` for that task's
 * own (404 for a task that is not the repo's). A message is answered
 * in the background (202); progress and the answer arrive as `chat.upserted`.
 * A message while the chat answers is refused (409) unless it is `/clear`.
 * The user can add an action to an assistant message, e.g. to turn a reply
 * into a task.
 */
export function chatRoutes(chat: ChatRouteService): Hono {
  const routes = new Hono();
  /** Undefined on the repo chat's mount. */
  const taskIdOf = (c: Context): string | undefined => c.req.param("taskId");

  routes.get("/", (c) => c.json(chat.get(c.req.param("repoId") ?? "", taskIdOf(c))));

  routes.post("/", async (c) => {
    const parsed = chatSendInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    return c.json(chat.send(c.req.param("repoId") ?? "", parsed.data.text, taskIdOf(c)), 202);
  });

  routes.post("/actions/:actionId/applied", (c) =>
    c.json(chat.markApplied(c.req.param("repoId") ?? "", c.req.param("actionId"), taskIdOf(c))),
  );

  routes.post("/messages/:messageId/actions", async (c) => {
    const parsed = chatActionProposalSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }
    return c.json(
      chat.addAction(
        c.req.param("repoId") ?? "",
        c.req.param("messageId"),
        parsed.data,
        taskIdOf(c),
      ),
    );
  });

  return routes;
}
