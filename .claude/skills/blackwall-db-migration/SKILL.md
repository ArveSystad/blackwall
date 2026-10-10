---
name: blackwall-db-migration
description: >
  The one correct way to change blackwall's SQLite schema: edit the Drizzle schema, generate the
  migration, commit the generated files together, then update shared zod schemas, repositories and
  tests. Use for ANY change to a table, column, index or foreign key in
  packages/core/src/db/schema.ts; for adding a new persisted field or entity; for a data backfill;
  and when asked to "add a column", "store X on the task", "new table" or "persist this".
---

# blackwall db migration

blackwall keeps all state in one local SQLite database, accessed through Drizzle on
better-sqlite3. The Drizzle schema is the source of truth and drizzle-kit generates every migration
from it. Migrations are never hand-numbered, and they apply automatically on every startup, so a
committed migration is already in users' databases.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, SQL and commit text stay normal prose.

## Sources of truth

1. **Schema:** `packages/core/src/db/schema.ts`. Tables, columns, indexes and foreign keys.
2. **Config:** `packages/core/drizzle.config.ts` (`dialect: "sqlite"`, `schema: "./src/db/schema.ts"`,
   `out: "./drizzle"`).
3. **Migrations:** `packages/core/drizzle/NNNN_name.sql`, plus `packages/core/drizzle/meta/_journal.json`
   and one `meta/NNNN_snapshot.json` per migration.
4. **Runtime:** `packages/core/src/db/database.ts`. `openDatabase` runs
   `migrate(db, { migrationsFolder: MIGRATIONS_DIR })` on every startup, with foreign keys off.
5. **Data access:** `packages/core/src/db/repositories.ts` maps rows to domain types.
6. **Domain types:** zod schemas in `packages/shared/src/domain.ts` (and `protocol.ts` for API
   payloads). `repositories.ts` imports their types from `@blackwall/shared`.

## Procedure for any schema change

1. Edit `packages/core/src/db/schema.ts`. Follow the existing column naming (camelCase in TS,
   snake_case in SQL) and the `onDelete` pattern below.
2. Generate the migration from the repo root:

   ```sh
   pnpm --filter @blackwall/core db:generate --name <snake_name>
   ```

   This runs `drizzle-kit generate`. Use a short snake_case name that says what changed.
3. drizzle-kit picks the `NNNN_` prefix, e.g. `0005_repo_backlog`, `0010_task_follow_ups`,
   `0011_cli_agnostic_agents`. Never rename the file or choose the number yourself.
4. Read the generated SQL. Check that it does what you meant, especially table rebuilds and dropped
   columns. If existing rows need a backfill, append the statements to the new, not yet committed
   file, each separated by `--> statement-breakpoint`, as `0011_cli_agnostic_agents.sql` does with
   its `UPDATE`s.
5. Commit the new `.sql`, the updated `meta/_journal.json` and the new `meta/NNNN_snapshot.json`
   together, in the same commit as the schema change.
6. Update the matching zod schema in `packages/shared/src/domain.ts` (or `protocol.ts`), then the
   row mapping, inserts and queries in `packages/core/src/db/repositories.ts`.
7. Add tests:
   - `packages/core/src/db/repositories.test.ts`: the new field or entity round-trips.
   - `packages/core/src/db/database.test.ts`: an existing database upgrades and keeps or backfills
     its data. Follow "upgrades a 0000_init database without losing child rows" and "moves each
     agent's CLI onto its tasks, backlog items and steps when agents lose it".
8. Run `pnpm typecheck && pnpm lint && pnpm test`.

## Foreign keys and `onDelete`

Pick `onDelete` by the existing pattern. Do not invent new semantics.

- `cascade`: child rows owned by a parent. Runs → tasks, steps → runs, step events → steps,
  findings and grill questions → tasks/runs, backlog items → repos.
- `set null`: optional back-references. `connectionId` on repos, `taskId` / `sourceTaskId` on
  backlog items, `stepId` and the agent references (`agentId`, `reviewerAgentId`,
  `askedByAgentId`), `mergedIntoId` on findings.
- `restrict`: `tasks.repoId`. A repo with tasks cannot be deleted.

## Rules

- Never edit, rename or delete an applied (committed) migration, its snapshot or its journal entry.
  Migrations auto-apply at startup through `openDatabase` in `db/database.ts`, so users' databases
  already contain them. Fix mistakes with a new migration.
- Appending backfill SQL is only allowed on the migration you just generated and have not committed.
- New columns on existing tables must have a `DEFAULT` or be nullable, or the upgrade fails on
  existing rows.
- Foreign keys are off while migrating, so drizzle-kit's table rebuilds do not cascade-delete child
  rows. Never rely on cascades or `set null` happening inside a migration; write the `UPDATE` or
  `DELETE` explicitly.
- Do not hand-write or hand-edit `meta/_journal.json` or snapshots. Regenerate instead.
- If the migration workflow, tooling or conventions change, update this skill in the same commit.

## Changing this skill

When the schema tooling (drizzle-kit, the `db:generate` script, `drizzle.config.ts`), the startup
migration in `database.ts` or the conventions above change, update this skill in the same commit so
it never contradicts the code.
