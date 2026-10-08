---
id: task-003
title: SQLite + Drizzle persistence
status: backlog
depends_on: [task-001]
---

## Goal
Durable local state in `~/.blackwall/blackwall.db`.

## Scope
- `better-sqlite3` + Drizzle; migrations run automatically on startup; WAL mode.
- Data dir `~/.blackwall`, overridable with `BLACKWALL_HOME`.
- Initial tables: settings, connections (no secrets), repos, agents, tags, tasks, runs, steps, step_events (append-only), findings, grill_questions.

## Acceptance criteria
- A fresh start creates the DB and applies migrations; restarts are idempotent.
- Repository layer in `packages/core` with tests against a temp DB.

## Refs
grill-result.md §2, §6, §9

## Notes
- `drizzle-orm` 0.45.x (stable) + `drizzle-kit` 0.31.x; `better-sqlite3` 13 is allowed to build in `pnpm-workspace.yaml`.
- Schema in `packages/core/src/db/schema.ts`; regenerate migrations with `pnpm --filter @blackwall/core db:generate --name <name>`. Output in `packages/core/drizzle/` (prettier-ignored) and is applied by `openDatabase()` on every start.
- `openDatabase(dataDir)` sets WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`. Data dir from `resolveDataDir(env)` (`BLACKWALL_HOME`, default `~/.blackwall`), exposed as `ServerConfig.dataDir`.
- Ids are random UUIDs, timestamps are epoch ms (`Date` in TS), JSON columns for lists/objects. `step_events` keyed by `(step_id, seq)`; the repository only appends.
- Server opens the DB at startup, closes it on shutdown, and marks steps left `running` as `interrupted` (§6).
- Repositories (`createRepositories(db)`) cover only what is needed now; extend as features land.
