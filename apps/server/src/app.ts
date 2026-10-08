import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import {
  APP_NAME,
  WS_PATH,
  parseClientEvent,
  type HealthResponse,
  type ServerEvent,
} from "@blackwall/shared";
import { Hono } from "hono";
import { hostGuard, requireToken, tokenExchange } from "./auth.js";
import { connectionRoutes, type ConnectionRoutesOptions } from "./connections.js";
import { errorResponse } from "./errors.js";

export interface AppOptions {
  token: string;
  /** Returns the port the server listens on (read lazily so port 0 works in tests). */
  getPort: () => number;
  /** Directory of the built SPA; omit in dev mode, where Vite serves it. */
  webDist?: string;
  /** Connection service and tester; omit to leave the connection routes out (e.g. in tests). */
  connections?: ConnectionRoutesOptions;
}

function send(ws: { send(data: string): void }, event: ServerEvent): void {
  ws.send(JSON.stringify(event));
}

export interface CreatedApp {
  app: Hono;
  injectWebSocket: NodeWebSocket["injectWebSocket"];
  wss: NodeWebSocket["wss"];
}

export function createApp({ token, getPort, webDist, connections }: AppOptions): CreatedApp {
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });

  app.use(hostGuard(getPort));
  app.use(tokenExchange(token, getPort));
  app.use("/api/*", requireToken(token, getPort));
  app.use(WS_PATH, requireToken(token, getPort));

  app.get("/api/health", (c) => c.json<HealthResponse>({ status: "ok", name: APP_NAME }));

  // Dev launch URL target: the token exchange has already set the cookie, so go to the app.
  app.get("/api/session", (c) => c.redirect("/", 302));

  // Domain errors, including `MissingCredential` for the missing-token modal.
  app.onError(errorResponse);

  if (connections) app.route("/api/connections", connectionRoutes(connections));

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  app.get(
    WS_PATH,
    upgradeWebSocket(() => ({
      onMessage(event, ws) {
        const message = parseClientEvent(typeof event.data === "string" ? event.data : "");
        if (!message) {
          send(ws, { type: "error", payload: { message: "invalid event" } });
          return;
        }
        switch (message.type) {
          case "ping":
            send(ws, { type: "pong", payload: { id: message.payload.id, serverTime: Date.now() } });
            break;
        }
      },
    })),
  );

  if (webDist) {
    const indexHtml = join(webDist, "index.html");
    if (!existsSync(indexHtml)) {
      console.warn(`Web build not found at ${webDist}; run \`pnpm build\` first.`);
    }
    app.use("/*", serveStatic({ root: webDist }));
    // SPA fallback: client-side routes resolve to index.html.
    app.get("/*", serveStatic({ path: indexHtml }));
  }

  return { app, injectWebSocket, wss };
}
