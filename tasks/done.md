# Done

Completed tasks, in order.

---

1. Scaffolded the pnpm monorepo (server, web, core, integrations, shared) with strict TypeScript 6, project references, ESLint, Prettier and Vitest; build, test and lint pass.
2. Added the Hono server skeleton on 127.0.0.1 with launch-token cookie auth, Host-header guard, typed WebSocket ping/pong, SPA serving with a Vite dev proxy, browser launch and graceful shutdown hooks.
3. Added SQLite persistence via better-sqlite3 + Drizzle in `~/.blackwall` (`BLACKWALL_HOME`), with WAL, auto-applied migrations for all initial tables, a tested repository layer in core, and startup wiring in the server.
