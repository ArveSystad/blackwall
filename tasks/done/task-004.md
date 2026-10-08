---
id: task-004
title: Domain model and shared schemas
status: backlog
depends_on: [task-001]
---

## Goal
One source of truth for types used by core, server and web.

## Scope
- zod schemas + inferred types in `packages/shared`: Task (origin, workspace, delivery targets, mode, triage mode), Run, Step, StepEvent, Finding, GrillQuestion, Agent, Connection, Repo, Settings.
- Finding: severity `critical | high | medium | low`, tags[], file + line range, title, explanation, suggested fix, status `open | fixed | force-fix | force-ignore`.
- GrillQuestion: asked by reviewer, `needsHuman`, answered by planner or user.
- Task status: `queued | running | needs-you | interrupted | failed | done`; stage enum for the pipeline.
- WS event types.

## Acceptance criteria
- Server validation and web forms use the same schemas; no duplicated type definitions.

## Refs
grill-result.md §2
