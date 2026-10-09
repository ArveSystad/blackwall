---
id: task-0030
title: Stop and delete tasks
status: backlog
depends_on: [task-028]
---

## Goal
Give the user a **Stop** button that halts a queued or running task, and a **Delete** button that removes a task with its worktree and branch, as long as nothing has been delivered yet (no push, PR or Jira write). Today the only way to get rid of a task that went wrong is to wait for it to fail.

## Motivation
Tasks sometimes head the wrong way: wrong repo, bad prompt, the plan is off, or the agent is burning tokens in a loop. The engine already knows how to abort a step (the per-task `AbortController` in `packages/core/src/pipeline/engine.ts`, used on shutdown) and the git service can remove a worktree and delete its branch (`removeWorktree({ deleteBranch })` in `packages/core/src/git/service.ts`). Neither is exposed to the user.

Depends on task-028 because that task changes the engine's interrupt handling (quota pauses) and the backlog runner. Stop and delete must play well with both.

## Scope

### Engine (`packages/core/src/pipeline/engine.ts`)
- `stop(taskId)`:
  - `queued`: `scheduler.dequeue`, set status `interrupted`.
  - `running`: abort the task's controller. The running step ends `interrupted` (its CLI session id is kept) and the task ends `interrupted` with `error: "Stopped by you"` or a dedicated flag, so the banner can tell a user stop apart from a crash or a quota pause.
  - `needs-you`: no-op, or clear the gate and set `interrupted`. Pick one and note it.
  - Reuse the existing interrupted path so **Resume** (`POST /:id/resume`) continues the step with `--resume <sessionId>`. No new task status needed. Kill child CLIs the same way shutdown does.
- `delete(taskId)`:
  - Allowed in any status except while delivery is in progress or after anything was delivered. Use the engine's `delivering` set and the task's delivery record; refuse with a typed error otherwise.
  - Stops the task first if it's queued or running, and waits for the drive loop to settle before removing anything.
  - Removes the worktree and deletes the local branch via `git.removeWorktree({ deleteBranch })`. Protected branches are already refused by `assertUnprotected`. A PR-review task works on an existing branch, so only remove its worktree there, never the branch.
  - Deletes the `tasks` row. Runs, steps, events, findings and grill questions cascade. A backlog item that promoted this task keeps `taskId: null` (FK is `set null`), and task-027's rules then treat it as not done.
  - Broadcasts a `task.deleted` WS event (add it to the shared event union).
- The backlog runner (task-028) must not count a stopped task as failed and must not halt the backlog because of it.

### API (`apps/server/src/tasks.ts`)
- `POST /api/tasks/:id/stop` returns the updated `Task`.
- `DELETE /api/tasks/:id` returns 204. It returns 409 when delivery has started or finished, and 404 for an unknown id.
- Route tests next to the existing ones.

### UI (`apps/web/src/components/task/`, Inbox)
Use the `blackwall-design` skill.
- `TaskHeader.tsx`: a **Stop** button while `queued`/`running` (keyboard shortcut, e.g. `S`, registered the way existing task hotkeys are), and **Delete** in an overflow or secondary position, styled as destructive.
- Delete always goes through `ConfirmDialog`, saying what is lost: "Removes the worktree, the local branch `x` and all run history." Hide or disable Delete once delivery has started, with a tooltip saying why.
- `TaskBanner.tsx`: when the task was stopped by the user, show "Stopped" (not the crash text "blackwall shut down while an agent was running") with **Resume** and **Delete**.
- `TaskCard.tsx` / Inbox: a delete action on the card's hover or context menu for tasks that can be deleted. A deleted task disappears from the list via the `task.deleted` event in `live.ts`. If the user is viewing the deleted task, go back to the Inbox.
- Wire the actions through `actions.ts` / `use-task-action.ts`.

## Acceptance criteria
- Stopping a running task kills its agent CLI within a couple of seconds. The task shows as stopped and Resume continues the same CLI session.
- Stopping a queued task removes it from the queue without starting it.
- Deleting an undelivered task removes its row, history, worktree and local branch (the branch is kept for PR-review tasks). Deleting a delivered task is refused by the API and not offered in the UI.
- Tests cover engine stop and delete (fake adapter), the routes, and the UI logic. `pnpm build`, `pnpm test` and `pnpm lint` pass.

## Refs
grill-result.md §6 (interrupt and resume), `packages/core/src/pipeline/engine.ts`, `packages/core/src/git/service.ts`, `apps/web/src/components/task/TaskBanner.tsx`, task-027, task-028

## Notes
