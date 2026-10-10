---
name: blackwall-api-slice
description: >
  How to add a vertical API slice in blackwall: shared zod schema, core service/repository, Hono
  route module, web fetcher/query/live handling. Use for adding an endpoint or route, a
  server/WebSocket event, or end-to-end data for a new screen; also when asked "expose X to the UI",
  "add an API for…", "push live updates for…".
---

# blackwall api slice

A feature's data runs through one slice: `packages/shared` (contract) → `packages/core` (logic and
storage) → `apps/server` (Hono route + WebSocket event) → `apps/web` (fetcher, query, live update).
The backlog is the reference slice. Copy its shape instead of inventing a new one.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, UI copy and commit text stay normal prose.

## Hard rules

- Bind only to 127.0.0.1. Never add a listener, host option or second server.
- Tokens live in the OS keychain or `BLACKWALL_TOKEN_*` env vars. They are never sent to the browser
  or stored in SQLite. Responses expose `hasToken: boolean` only (see `domain.ts`, `connections.ts`).
- Nothing leaves the machine outside confirmed delivery at finish. The one exception is the
  user-confirmed "Push to main" on a repo's Backlog (`RepoService.push`). Agents never push.
- Error responses carry only messages known to be secret-free (`errorResponse` in `errors.ts`).
- Any UI you build for the slice follows the `blackwall-design` skill.

## Reference slice: backlog

- `packages/shared/src/domain.ts`: backlog schemas and types (`backlogPrioritySchema` / `BacklogPriority`).
- `packages/shared/src/protocol.ts`: the `backlog.changed` event in `serverEventSchema`.
- `packages/core/src/pipeline/backlog.ts`: pure logic (`sortBacklog`, `unmetDependencies`,
  `createsDependencyCycle`); `packages/core/src/db/repositories.ts`: the `backlogItems` store.
- `apps/server/src/backlog.ts` + `backlog.test.ts`: the route module and its tests.
- `apps/server/src/app.ts`: the optional `backlog` field on `AppOptions` and its mount.
- `apps/web/src/api.ts`, `query.ts`, `live.ts`, `backlog.ts`: fetchers, queries, live invalidation, view logic.

## 1. Shared contract

1. In `packages/shared/src/domain.ts`, add `xxxSchema` and `export type Xxx = z.infer<typeof xxxSchema>`.
   Add an input schema for POST/PATCH bodies so server and web validate the same shape.
2. `packages/shared/src/index.ts` re-exports `domain.js` and `protocol.js`; a new file needs its own line.
3. For a live update, add an `envelope("area.changed", z.object({ ... }))` variant to
   `serverEventSchema` in `protocol.ts`, with a doc comment saying what the client should do.
4. Prefer a small "refetch" payload (ids) over full objects, like `backlog.changed` (`{ repoId }`).
5. Add a parse test in `protocol.test.ts`, following "parses a step event and revives its timestamp".

## 2. Core

1. Pure logic goes in a service under `packages/core/src/<module>/`, exported through its `index.ts`
   and so from `@blackwall/core`.
2. Persistence goes in `packages/core/src/db/repositories.ts`. A table change goes in
   `db/schema.ts` plus a migration in `packages/core/drizzle/` (`pnpm --filter @blackwall/core db:generate`).
3. Throw typed domain errors (`XxxNotFoundError`, `InvalidXxxError`, or a state error like
   `TaskStateError`) and export them from `@blackwall/core`.
4. Tests sit next to the code (`*.test.ts`).

## 3. Server route

1. `apps/server/src/<area>.ts` exports `<area>Routes(options, services)` returning a `Hono` app.
2. Options take narrow stores, e.g. `Pick<Repositories["repos"], "get">` (see `BacklogRouteOptions`).
   Services take `broadcast: (event: ServerEvent) => void` (see `BacklogRouteServices`). Call it
   after each successful change.
3. Validate bodies with the shared input schemas.
4. In `app.ts`, add an optional `AppOptions` field with a doc comment
   (`/** … omit to leave the <area> routes out (e.g. in tests). */`) and mount it:
   `if (area) { app.route("/api/...", areaRoutes(area, { broadcast })) }`.
5. Don't catch errors in the route; `app.onError(errorResponse)` handles them. Map each new
   domain error class in `errors.ts`: not found → 404, invalid → 400, state conflict → 409.
   Unmapped errors become a generic 500, so never rely on that for expected cases.
6. Wire the real stores: add the option to `StartOptions` in `apps/server/src/server.ts` (passed to
   `createApp`) and supply it from `startServer(...)` in `apps/server/src/index.ts`.
7. Test in `<area>.test.ts` against `createApp({...})`: status codes, response bodies (no token
   fields) and the broadcast events, e.g. `{ type: "backlog.changed", payload: { repoId } }`.

## 4. Web

1. Add a fetcher with a doc comment in `apps/web/src/api.ts` using
   `request(path, schema, { method, body })` or `requestEmpty`, and build paths with `at(...)`
   (see `listBacklog`, `createBacklogItem`).
2. In `query.ts`, add a `queryKeys.<area>` entry and an `<area>Query(...)` options factory
   (see `backlogQuery`). Use prefix keys so one invalidation covers related queries.
3. Handle the new event in the `live.ts` switch: `case "<area>.changed":` invalidates
   `queryKeys.<area>(...)`. Add a case to `live.test.ts`.
4. Put view logic in `apps/web/src/<area>.ts` with tests. UI follows `blackwall-design`.

## Checklist

- [ ] Schema + `z.infer` type (and input schema) in `domain.ts`
- [ ] Event in `protocol.ts` with doc comment, plus a `protocol.test.ts` case
- [ ] Core service/repository, typed errors exported from `@blackwall/core`, migration if needed
- [ ] Route module, documented `AppOptions` field and mount in `app.ts`, errors mapped in `errors.ts`
- [ ] Stores wired through `server.ts` and `index.ts`
- [ ] `<area>.test.ts` covers statuses, bodies without tokens and broadcasts
- [ ] Fetcher in `api.ts`, query in `query.ts`, `live.ts` case with test
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass

## Keeping this skill current

If you change this slice pattern (paths, helpers, mounting, event shape), update this skill in the
same commit.
