---
id: task-014
title: Pipeline engine, scheduler and resume
status: backlog
depends_on: [task-003, task-004, task-010, task-013]
---

## Goal
The hardcoded state machine that drives tasks through their stages.

## Scope
- Stages: Inform → Plan review/grill → plan approval → Implement → Checks → Code review loop → Summarize → finish confirmation. Review PR mode: Inform → Review panel → triage → post.
- Steps persisted with session id and streamed events as they arrive; broadcast over WS.
- Scheduler: max N concurrent tasks per repo (default 3), one active task per branch; tasks waiting on the user don't hold a slot.
- Shutdown kills child CLIs; on restart, in-flight steps become `interrupted` and Resume re-runs them with `--resume <sessionId>`.
- Review loop cap of 3 rounds, then escalate to the user.

## Acceptance criteria
- An end-to-end test with a fake adapter drives a task through every stage, including an interrupt and resume.
- The scheduler respects per-repo and per-branch limits.

## Refs
grill-result.md §3, §6
