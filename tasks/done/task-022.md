---
id: task-022
title: Seed prompts for built-in agents
status: backlog
depends_on: [task-012]
---

## Goal
Good default personas so the pipeline works out of the box.

## Scope
- Prompts for planner, plan reviewer (grilling style, `needsHuman` routing), implementer (no commits, no pushes), summarizer (commit messages + final summary), and reviewers: code quality, security, UX/design, performance.
- Shared output contracts (plan, questions, findings) referenced by all prompts.

## Acceptance criteria
- Both CLIs produce parseable output for every contract on a sample repo.

## Refs
grill-result.md §3, §5
