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
