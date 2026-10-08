---
id: task-002
title: Server skeleton (Hono, localhost, launch token, WebSocket, SPA serving)
status: backlog
depends_on: [task-001]
---

## Goal
A single local process serving the API, WebSocket and built SPA.

## Scope
- Hono on Node, bound to `127.0.0.1` only, with a configurable port.
- Random per-launch token required on every API/WS request (the URL `?t=` is exchanged for an httpOnly cookie on first load).
- Reject requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- WebSocket endpoint with a typed event envelope from `packages/shared`.
- Serve `apps/web/dist` in prod; Vite dev server in dev.
- Print the launch URL and open the browser unless `--no-open`.
- Graceful shutdown hook (used later to kill agent child processes).

## Acceptance criteria
- Requests without the token, or with a foreign Host header, are rejected.
- Health endpoint and WS ping/pong work from the web app.

## Refs
grill-result.md §9

## Notes
- `@hono/node-server` pinned to 1.19.x because `@hono/node-ws` 1.3.x peers on `^1.19`; 2.x was released the day this landed.
- Dev: `pnpm dev` runs the server with `--dev --no-open` on 4711 and Vite on 5173 (`BLACKWALL_PORT` / `BLACKWALL_WEB_PORT`), proxying `/api` and `/ws` with `changeOrigin` so the Host check passes. The dev launch URL is `http://127.0.0.1:5173/api/session?t=…`, which sets the cookie and redirects to `/`. tsx watch restarts mint a new token, so reopen the printed URL.
- Cookie is `blackwall_token_<port>` (httpOnly, SameSite=Strict); static SPA files are public, `/api/*` and `/ws` need the cookie.
- Shutdown hooks run in reverse registration order on SIGINT/SIGTERM via `createShutdown().onShutdown()`.
- Existing `node_modules` linked to a virtual store in an old checkout path; reinstalled from scratch.
