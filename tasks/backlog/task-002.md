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
