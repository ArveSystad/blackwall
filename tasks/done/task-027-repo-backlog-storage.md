---
id: task-027
title: Per-repo backlog — storage, API and pick order
status: backlog
depends_on: []
---

## Goal
Let the user park work in a per-repository backlog inside blackwall, stored in the app's SQLite database rather than as markdown files. This task adds the data model, the REST/WS surface and the deterministic "what runs next" function. Running items automatically is task-028; the UI is task-029.

## Motivation
This repo's own `tasks/` folder (backlog files, `depends_on`, `pick-next-task.ps1`, ralph) works well for queuing up work and letting an agent chew through it unattended. blackwall should offer the same thing per registered repo, without files in the target repo: write down a task now, and let blackwall run it later when it has spare capacity or when token quotas have reset.

A backlog item is **not** a task yet. Today `POST /api/tasks` creates a `tasks` row with status `queued`, and the scheduler (`packages/core/src/pipeline/scheduler.ts`) starts it as soon as a slot is free. Backlog items wait until they are explicitly promoted (by the user, or by the runner in task-028). Promotion goes through the existing `pipeline.createTask` path, so nothing downstream changes.

## Scope

### Data model (`packages/core/src/db/schema.ts` + a new migration in `packages/core/drizzle/`)
New table `backlog_items`:

| column | notes |
|---|---|
| `id` | `id()` helper |
| `repoId` | FK → `repos.id`, `onDelete: "cascade"` |
| `title` | required, max 120 chars (same as `MAX_TITLE_CHARS` in `apps/server/src/tasks.ts`) |
| `origin` | JSON `TaskOrigin` (free text, Jira issue or PR), same as on `tasks` |
| `mode` | PR mode, PR origins only |
| `freeText` | the task description (markdown) |
| `agents` | JSON `RoleAgents` overrides, default `{}` |
| `triageMode` | default `"intervene"`; backlog items are meant to run unattended, so the form should default to this |
| `priority` | enum `high` / `normal` / `low`, default `normal` |
| `position` | integer, manual order inside a priority bucket |
| `dependsOn` | JSON array of backlog item ids |
| `status` | enum `waiting` / `promoted` / `paused`; `paused` = user held it back |
| `taskId` | FK → `tasks.id`, `onDelete: "set null"`; set when promoted |
| `createdAt`, `updatedAt` | helpers |

Index on `(repoId, status)`. Add `BACKLOG_PRIORITIES` / `BACKLOG_STATUSES` constants and zod schemas in `packages/shared/src/domain.ts` next to `TASK_STATUSES`, plus `BacklogItem`, `newBacklogItemInputSchema` and `updateBacklogItemInputSchema`. Reuse the field shapes of `newTaskInputSchema` where possible.

### Repository (`packages/core/src/db/repositories.ts`)
`backlogItems`: `list(repoId?)`, `get(id)`, `insert`, `update`, `delete`, `reorder(repoId, orderedIds)`, `markPromoted(id, taskId)`.

### Pick order (`packages/core/src/pipeline/backlog.ts`, new, pure function)
`nextBacklogItem(items, isDone)` returns the next eligible item for one repo, or `undefined`. Rules, mirroring `tasks/pick-next-task.ps1`:
- Only `waiting` items count; `paused` and `promoted` are skipped.
- Order: priority bucket (`high` → `normal` → `low`), then `position`, then `createdAt`.
- An item whose dependencies aren't done is skipped. When the head item is blocked, descend into its unmet dependencies in listed order and return the first ready one, so dependencies run before the items that need them.
- A dependency is done when its item is `promoted` and the linked task's status is `done`. A dependency id that no longer exists blocks the item. A failed/cancelled linked task also blocks it.
- Cycles must not loop forever (track visited ids).

Unit tests in `backlog.test.ts` covering priority, position, dependency descent, missing deps, cycles and paused items.

### API (`apps/server/src/backlog.ts`, new; mount at `/api/repos/:repoId/backlog` or `/api/backlog?repoId=`, whichever fits `app.ts`)
- `GET` list (per repo, ordered by pick order, each item annotated with `blocked: boolean` and `blockedBy: string[]`)
- `POST` create; `PATCH /:id` edit (title, freeText, priority, dependsOn, status `waiting`↔`paused`, agents, triageMode); `DELETE /:id`
- `POST /reorder` with the ordered ids
- `POST /:id/run` promotes now: builds the same input `POST /api/tasks` uses (resolve roles, `repos.use(repoId)`, title fallback) and calls `pipeline.createTask`, then `markPromoted`. Pull the shared part of the task-creation route in `apps/server/src/tasks.ts` into a helper rather than duplicating it.
- Validate that `dependsOn` only references items in the same repo, and reject edits that would create a cycle.
- Broadcast `backlog.changed` (with `repoId`) over the existing WS channel on every mutation so the UI can refetch.

Route tests next to the existing ones (`apps/server/src/*.test.ts` style).

## Out of scope
Automatic promotion (task-028), web UI (task-029), importing from `tasks/` markdown files.

## Acceptance criteria
- Backlog items persist across restarts and are scoped per repo; deleting a repo removes its backlog.
- `nextBacklogItem` matches the ordering and dependency rules above, with tests.
- `POST /:id/run` produces a normal queued task that the scheduler starts like any other.
- `pnpm build`, `pnpm test` and `pnpm lint` pass.

## Refs
`tasks/pick-next-task.ps1`, `packages/core/src/pipeline/scheduler.ts`, `apps/server/src/tasks.ts`, grill-result.md §6
