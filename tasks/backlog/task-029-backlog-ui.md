---
id: task-029
title: Backlog UI — per-repo list, add/edit, runner status
status: backlog
depends_on: [task-027, task-028]
---

## Goal
Give each repo a backlog view in the web app: add items, order them, set dependencies, see what runs next and why the runner is idle, paused or halted.

## Scope
Use the `blackwall-design` skill for tokens, components and keyboard model. Add a mockup to `docs/design/` first if no existing screen fits (Inbox.dc.html / NewTask.dc.html are the nearest references).

- **Route** `apps/web/src/routes/Backlog.tsx`, reachable per repo (e.g. `/repos/:repoId/backlog`) and from the Home/Inbox sidebar with a count of waiting items per repo.
- **List**: grouped by priority, ordered by pick order (from the API). Each row shows title, priority, dependencies, and a state: *next up*, *blocked by …*, *paused*, *promoted → task link* (with the task's `StatusBadge`). Drag or keyboard (`alt+↑/↓`) to reorder inside a bucket.
- **Add/edit**: reuse `NewTaskModal.tsx` with an "Add to backlog" mode that adds priority and depends-on (multi-select of the repo's other waiting items) and hides fields that only make sense right now. Triage mode defaults to "Run and let me intervene". A quick-add input at the top of the list for title-only free-text items.
- **Row actions**: Run now (`POST /:id/run`), pause/unpause, edit, delete (via `ConfirmDialog`).
- **Runner status bar** for the repo: on/off toggle (per-repo setting), "Idle — next: X", "Waiting: 2 tasks running", "Paused: Claude quota resets 14:32" (live countdown from `/api/quota`), "Halted: task Y failed — Resume". Show quota pauses globally too, e.g. a small chip in the header.
- **Settings**: a Backlog section in `routes/Settings.tsx` / `settings-sections.ts` for the global runner settings from task-028.
- **Live updates**: subscribe to `backlog.changed` and `quota.changed` in `live.ts` and invalidate the matching queries.

## Acceptance criteria
- A user can add, reorder, prioritise, link, pause, run and delete backlog items for a repo without touching files.
- The status bar always says why the runner is or isn't promoting something.
- Works in dark and light themes; keyboard reachable.
- Component/logic tests in the style of `inbox.test.ts` / `task-view.test.ts`; `pnpm build`, `pnpm test` and `pnpm lint` pass.

## Refs
task-027, task-028, `apps/web/src/components/NewTaskModal.tsx`, `apps/web/src/components/Inbox.tsx`, docs/design/
