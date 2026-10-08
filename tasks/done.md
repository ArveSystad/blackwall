# Done

Completed tasks, in order.

---

1. Scaffolded the pnpm monorepo (server, web, core, integrations, shared) with strict TypeScript 6, project references, ESLint, Prettier and Vitest; build, test and lint pass.
2. Added the Hono server skeleton on 127.0.0.1 with launch-token cookie auth, Host-header guard, typed WebSocket ping/pong, SPA serving with a Vite dev proxy, browser launch and graceful shutdown hooks.
3. Added SQLite persistence via better-sqlite3 + Drizzle in `~/.blackwall` (`BLACKWALL_HOME`), with WAL, auto-applied migrations for all initial tables, a tested repository layer in core, and startup wiring in the server.
4. Added the shared domain model in `packages/shared` (zod schemas and inferred types for tasks, runs, steps, events, findings, grill questions, agents, connections, repos, settings, form inputs and WebSocket events), made core's Drizzle schema and repositories use it, and migrated tasks to typed origins, statuses and stages.
5. Added the secret store: a `SecretStore` interface in core backed by the OS keychain via `@napi-rs/keyring` (service `blackwall`, account = connection id), `BLACKWALL_TOKEN_<CONNECTION>` env overrides that win over the keychain, and connection token routes whose responses expose only `hasToken`.
6. Added connections: CRUD routes for GitHub/GHE and Jira Cloud (email in metadata, token in the keychain), "Test connection" via GitHub `GET /user` and Jira `GET /rest/api/3/myself`, resolution by git remote host or Jira URL, a `MissingCredential` (409) server error, and a missing-token modal in the web app that saves the token (creating the connection if needed) and retries the action.
