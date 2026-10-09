---
id: task-024
title: Update create task skill
status: backlog
depends_on: []
---

Update the create task skill to match the structure in the now finished task-001.md

Also add that tasks should be named "0123-task-summary.md" instead of the current "task-0123.md" for more clarity.

## Notes
- The create-task skill lives at `.claude/commands/create-task.md`; it now uses task-001's frontmatter + Goal/Scope/Acceptance criteria/Refs/Notes structure and names new files `NNNN-short-summary.md` with `id: task-NNNN`.
- Existing task files keep their names. `pick-next-task.ps1` now sorts within a priority bucket by task number (leading digits, or digits after `task-`), so `0030-*` files queue after `task-025`..`task-029` instead of jumping ahead alphabetically.
