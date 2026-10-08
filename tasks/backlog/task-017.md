---
id: task-017
title: Plan review / grill stage and plan approval
status: backlog
depends_on: [task-012, task-014]
---

## Goal
Reviewers grill the plan; humans only answer what needs a human.

## Scope
- Planner produces a plan; plan-reviewer panel produces questions with a `needsHuman` flag.
- Planner answers questions the repo can answer; `needsHuman` ones become `needs-you` items in the UI.
- Plan is revised with the answers; loop until reviewers are satisfied (capped).
- Human approves or requests changes before implementation.

## Acceptance criteria
- A task cannot reach Implement without explicit user plan approval.

## Refs
grill-result.md §3
