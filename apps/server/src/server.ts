import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { AgentService, RepoService, Repositories } from "@blackwall/core";
import { TOKEN_QUERY_PARAM } from "@blackwall/shared";
import { createApp } from "./app.js";
import { generateToken } from "./auth.js";
import type { ConnectionRoutesOptions } from "./connections.js";
import type { Shutdown } from "./shutdown.js";

export const HOSTNAME = "127.0.0.1";

/** Built SPA, relative to this file in both `src/` and `dist/`. */
export const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface StartOptions {
  port: number;
  dev: boolean;
  /** Origin of the Vite dev server (dev mode only). */
  webDevOrigin?: string;
  token?: string;
  connections?: ConnectionRoutesOptions;
  repos?: RepoService;
  agents?: AgentService;
  tasks?: Repositories["tasks"];
  shutdown: Shutdown;
}

export interface RunningServer {
  port: number;
  token: string;
  /** URL that exchanges the token for a cookie and lands on the app. */
  launchUrl: string;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const token = options.token ?? generateToken();
  let port = options.port;
  const { app, injectWebSocket, wss } = createApp({
    token,
    getPort: () => port,
    ...(options.connections ? { connections: options.connections } : {}),
    ...(options.repos ? { repos: options.repos } : {}),
    ...(options.agents ? { agents: options.agents } : {}),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(options.dev ? {} : { webDist: WEB_DIST }),
  });

  const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port: options.port });
  injectWebSocket(server);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  port = (server.address() as AddressInfo).port;

  options.shutdown.onShutdown(
    () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );

  const query = `?${TOKEN_QUERY_PARAM}=${token}`;
  const launchUrl =
    options.dev && options.webDevOrigin
      ? `${options.webDevOrigin}/api/session${query}`
      : `http://${HOSTNAME}:${port}/${query}`;

  return { port, token, launchUrl };
}
