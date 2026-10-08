---
id: task-012
title: Agent library, role defaults and permission profiles
status: backlog
depends_on: [task-003, task-004]
---

## Goal
User-managed agents that the pipeline assigns to roles.

## Scope
- Agent CRUD: name, CLI, model, prompt/persona, eligible stages, permission override.
- Seeds: Planner, Implementer, Summarizer, Plan reviewer, Code-quality reviewer, Security reviewer, UX/design reviewer, Performance reviewer, with mixed vendors between authors and reviewers.
- Permission profiles per CLI. Reviewer: read-only + safe git (`git diff`, `git log`, `git show`). Implementer: edit + shell, deny `git push`, `git remote`, `gh` and remote-touching commands. Both confined to the worktree.
- Reviewer prompts get the current tag list and the findings output contract injected.

## Acceptance criteria
- A reviewer cannot edit files and an implementer cannot `git push`, verified with both CLIs.

## Refs
grill-result.md §5
