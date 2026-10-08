---
id: task-018
title: Implement + Checks stage
status: backlog
depends_on: [task-012, task-013, task-014]
---

## Goal
Write code, then verify it deterministically.

## Scope
- Implementer runs in the worktree with the approved plan (and on later rounds, the findings to fix).
- Harness commits after each round with a summarizer-written message prefixed with the Jira key.
- Run the repo's check commands; on failure feed output back to the implementer before reviewers run; a persistent failure becomes a Critical `correctness` finding.

## Acceptance criteria
- A failing check never reaches the review panel without one implementer retry.

## Refs
grill-result.md §3, §4
