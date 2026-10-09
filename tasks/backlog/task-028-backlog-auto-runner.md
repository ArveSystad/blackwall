---
id: task-028
title: Backlog runner — promote items when idle and quotas allow
status: backlog
depends_on: [task-027]
---

## Goal
Have blackwall work through each repo's backlog on its own: when a repo has spare capacity and the agent CLIs aren't rate-limited, promote the next backlog item (task-027's `nextBacklogItem`) into a real task. In effect a built-in ralph loop per repo.

## Motivation
The point of the backlog is "write it down now, let blackwall do it when it has time". There are two kinds of "time": free run slots (nothing else of mine is running in that repo) and free quota (Claude/Codex/Copilot usage limits have reset). Without the second, an unattended runner would burn through the backlog into a wall of failed tasks the moment a quota runs out.

## Scope

### Runner (`packages/core/src/pipeline/backlog-runner.ts`, new)
`createBacklogRunner({ repositories, scheduler, createTask, settings, quota, clock })` with `tick()` and `start()`/`stop()`.
- `tick()` runs on an interval (e.g. 30 s) and right after the events that free capacity: a task reaches `done`/`failed`/`needs-you`, a backlog item changes, a quota pause expires. Hook it into the engine's task status changes, not just polling.
- **Idle rule, per repo:** promote only when the repo has no `queued` tasks and fewer `running` tasks than the backlog limit. Default backlog limit is 1 concurrent backlog-originated task per repo, which keeps the backlog as background work and leaves the rest of the concurrency cap (`maxPerRepo`) to tasks the user starts by hand. Make the limit a setting.
- Promote at most one item per repo per tick; reuse the promote helper from task-027 so the task looks exactly like one started from the "Run now" button.
- Skip repos whose backlog runner is switched off (see Settings) and items whose resolved agents use a CLI that is currently quota-paused.
- Sequential by construction: a promoted item's task occupies the backlog slot until it leaves `running`/`queued`. If it ends in `needs-you`, the slot frees up and the runner may move on (matching grill-result §6: tasks waiting on the user don't hold a slot). Add a setting "stop the backlog when a task needs me" (default **on**) so the runner doesn't stack up several half-done tasks waiting on the user.
- If a promoted task fails, mark the repo's backlog as halted (like ralph halting on error) and surface that; the user resumes it from the UI. Don't promote dependants of a failed item.

### Quota awareness (`packages/core/src/agents/quota.ts`, new)
- Track `pausedUntil` per agent CLI (`claude`, `codex`, `copilot`), persisted in settings so a restart keeps it.
- Detect limits in the adapters (`packages/core/src/agents/adapters/`):
  - Claude: stream-json `rate_limit_event` lines, currently dropped in `adapters/claude.ts`. Parse status and reset time instead of discarding them, plus the "usage limit reached" result/stderr text with its reset epoch.
  - Codex / Copilot: the equivalent limit errors on stderr/exit (`AgentProcessError` in `adapters/types.ts` exposes `stderr` and `exitCode`). Write these detectors against captured fixtures; if a CLI gives no reset time, back off (e.g. 15 min, doubling, capped at 5 h).
- Emit a new adapter event `{ type: "rate-limit", resetsAt?: string }` and have the engine report it to the quota tracker.
- A step that dies on a quota limit should leave its task **interrupted** (resumable via the existing Resume with `--resume <sessionId>`), not `failed`. Once the quota resets, the runner resumes those interrupted tasks before promoting new backlog items.
- Hard limits only. Spreading usage out across a quota window is out of scope.

### Settings (`packages/core/src/settings/service.ts`, `apps/server/src/settings.ts`)
- Global: backlog runner on/off (default on), max concurrent backlog tasks per repo (default 1), stop when a task needs me (default on).
- Per repo: backlog runner on/off (default on), stored on the repo registry entry or in settings keyed by repo id.
- Expose the quota state read-only: `GET /api/quota` → `{ cli, pausedUntil }[]`, broadcast `quota.changed` over WS.

### Wiring (`apps/server/src/index.ts` / `server.ts`)
Start the runner with the engine, stop it in `shutdown.ts`.

## Acceptance criteria
- With the runner on and an idle repo, the top eligible backlog item becomes a task within one tick, and the next one only after it finishes.
- Manually started tasks in the same repo take priority: the runner waits while any are queued.
- A simulated Claude rate-limit event (fake adapter in `pipeline/fake-adapter.ts`) pauses promotion for items using Claude until the reset time, leaves the affected task interrupted, and resumes it afterwards.
- Runner, quota tracker and detectors have unit tests using a fake clock.
- `pnpm build`, `pnpm test` and `pnpm lint` pass.

## Refs
task-027, `packages/core/src/pipeline/scheduler.ts`, `packages/core/src/pipeline/engine.ts`, `packages/core/src/agents/adapters/claude.ts`, grill-result.md §6
