---
name: create-task
description: 'Create a new task file in /tasks/backlog/. Use when the user wants to plan, define, or capture a new piece of work.'
argument-hint: 'Description of the task to create (e.g. "add user notifications")'
---

# Create Task

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. The task file content itself stays normal prose (caveman's own boundaries).

## Procedure

### 1. Pick the next number

Find the highest task number used anywhere in `tasks/backlog/`, `tasks/in-progress/` and `tasks/done/`, and add 1. Numbers come from the filename prefix (`0031-...md`) or, for older files, from the `task-NNN` id (`task-027-...md`, `task-012.md`). Numbers are never reused.

### 2. Name the file

`tasks/backlog/<NNNN>-<short-summary>.md`

- `<NNNN>` is the number zero-padded to four digits: `0031`.
- `<short-summary>` is two to five lowercase, hyphenated words saying what the task does: `0031-backlog-ui.md`, `0032-theme-toggle.md`.
- Do not use the old `task-0123.md` form for new tasks. Existing files keep their names.
- The picker orders tasks within a priority bucket by this number, so lower numbers run first (see `pick-next-task`).

### 3. Write the file

Use this structure (task-001 in `tasks/done/` is the reference):

```markdown
---
id: task-0031
title: Short human title
status: backlog
depends_on: []
---

## Goal
One or two sentences: what this task delivers and why it matters.

## Motivation
Optional. Background the implementer needs to understand the why — the problem today, the user need, how it fits with neighbouring tasks.

## Scope
- Concrete list of changes: files, modules, endpoints, tables, components.
- Name the specific code areas to touch (e.g. `packages/core/src/pipeline/scheduler.ts`) and include short code snippets or signatures where they remove ambiguity.
- Use `###` subsections for larger tasks (Data model, API, UI, ...).

## Acceptance criteria
- Observable, checkable outcomes: commands that pass, behaviour a user can see, tests that exist.

## Refs
Optional. Pointers to design docs, mockups or earlier tasks (e.g. `grill-result.md §9`, `docs/design/...`).

## Notes
Left empty on creation. The implementer fills it with decisions and gotchas worth keeping.
```

Frontmatter rules:

- `id` is `task-` plus the same four-digit number as the filename.
- `status` is always `backlog` on creation.
- `depends_on` lists the ids of tasks that must be done first, e.g. `depends_on: [task-0031]`; existing three-digit ids such as `task-027` stay valid. Use `[]` when there are none. Keep the frontmatter at the top: the picker only reads the first 20 lines.

### 4. Split big work

If the task is too large for one focused session, split it into several numbered tasks and chain them with `depends_on`. Each part should leave the build, tests and lint green on its own. Mention in each task's Goal which neighbouring task covers the rest.
