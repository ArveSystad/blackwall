import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket, type NodeWebSocket } from "@hono/node-ws";
import {
  APP_NAME,
  WS_PATH,
  parseClientEvent,
  type CliStatus,
  type HealthResponse,
  type ServerEvent,
} from "@blackwall/shared";
import type {
  AgentService,
  ChatService,
  DataService,
  QuotaTracker,
  RepoService,
  SettingsService,
  SystemService,
} from "@blackwall/core";
import { Hono } from "hono";
import { agentRoutes } from "./agents.js";
import { backlogRoutes, type BacklogRouteOptions } from "./backlog.js";
import { chatRoutes } from "./chat.js";
import { cliRoutes } from "./clis.js";
import { hostGuard, requireToken, tokenExchange } from "./auth.js";
import { connectionRoutes, type ConnectionRoutesOptions } from "./connections.js";
import { dataRoutes } from "./data.js";
import { errorResponse } from "./errors.js";
import { issueRoutes, pullRequestRoutes } from "./github.js";
import { quotaRoutes } from "./quota.js";
import { repoRoutes } from "./repos.js";
import { settingsRoutes, tagRoutes } from "./settings.js";
import { systemRoutes } from "./system.js";
import {
  taskRoutes,
  type TaskPipeline,
  type TaskRouteServices,
  type TaskRouteStores,
} from "./tasks.js";

export interface AppOptions {
  token: string;
  /** Returns the port the server listens on (read lazily so port 0 works in tests). */
  getPort: () => number;
  /** Directory of the built SPA; omit in dev mode, where Vite serves it. */
  webDist?: string;
  /** Connection service and tester; omit to leave the connection routes out (e.g. in tests). */
  connections?: ConnectionRoutesOptions;
  /** Repo registry; omit to leave the repo routes out (e.g. in tests). */
  repos?: RepoService;
  /** Agent library; omit to leave the agent routes out (e.g. in tests). */
  agents?: AgentService;
  /** Tags and general settings; omit to leave the tag and settings routes out (e.g. in tests). */
  settings?: SettingsService;
  /** Task and grill question stores; omit to leave the task routes out (e.g. in tests). */
  tasks?: TaskRouteStores;
  /** Pipeline engine for resuming tasks, answering gates and questions; omit to leave those routes out. */
  pipeline?: TaskPipeline;
  /** Task creation, per-round and whole-branch diffs and artifacts; omit to leave those routes out. */
  taskServices?: TaskRouteServices;
  /** Backlog stores and runner hooks; omit to leave the backlog routes out (e.g. in tests). */
  backlog?: BacklogRouteOptions;
  /** The repo chat; omit to leave the chat routes out (e.g. in tests). */
  chat?: Pick<ChatService, "get" | "send" | "markApplied">;
  /** Agent CLI usage limits; omit to leave the quota route out (e.g. in tests). */
  quota?: Pick<QuotaTracker, "state">;
  /** Agent CLI detection, started at launch; omit to leave the CLI route out (e.g. in tests). */
  clis?: () => Promise<CliStatus[]>;
  /** Data export and import; omit to leave the data routes out (e.g. in tests). */
  data?: Pick<DataService, "export" | "import">;
  /** Database and disk stats and compacting; omit to leave the system routes out (e.g. in tests). */
  system?: Pick<SystemService, "snapshot" | "compact">;
}

function send(ws: { send(data: string): void }, event: ServerEvent): void {
  ws.send(JSON.stringify(event));
}

export interface CreatedApp {
  app: Hono;
  injectWebSocket: NodeWebSocket["injectWebSocket"];
  wss: NodeWebSocket["wss"];
  /** Sends an event to every connected client. */
  broadcast(event: ServerEvent): void;
}

export function createApp({
  token,
  getPort,
  webDist,
  connections,
  repos,
  agents,
  settings,
  tasks,
  pipeline,
  taskServices,
  backlog,
  chat,
  quota,
  clis,
  data,
  system,
}: AppOptions): CreatedApp {
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
  if (backlog) {
    app.route(
      "/api/repos/:repoId/backlog",
      backlogRoutes(backlog, {
        broadcast: (event) => {
          broadcast(event);
          if (event.type === "backlog.changed") backlog.onChanged?.(event.payload.repoId);
        },
        ...(backlog.runner ? { runner: backlog.runner } : {}),
        ...(pipeline ? { pipeline } : {}),
        ...(taskServices?.newTask ? { newTask: taskServices.newTask } : {}),
      }),
    );
  }
  if (chat) app.route("/api/repos/:repoId/chat", chatRoutes(chat));
  if (repos) app.route("/api/repos", repoRoutes(repos));
  if (repos && connections) {
    app.route(
      "/api/pull-requests",
      pullRequestRoutes({ connections: connections.connections, repos }),
    );
    app.route("/api/issues", issueRoutes({ connections: connections.connections, repos }));
  }
  if (agents) app.route("/api/agents", agentRoutes(agents));
  if (settings) {
    app.route("/api/tags", tagRoutes(settings));
    app.route("/api/settings", settingsRoutes(settings));
  }
  if (tasks) app.route("/api/tasks", taskRoutes(tasks, pipeline, taskServices));
  if (clis) app.route("/api/clis", cliRoutes(clis));
  if (quota) app.route("/api/quota", quotaRoutes(quota));
  if (data) app.route("/api/data", dataRoutes(data));
  if (system) app.route("/api/system", systemRoutes({ system }));

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

  function broadcast(event: ServerEvent): void {
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  return { app, injectWebSocket, wss, broadcast };
}
