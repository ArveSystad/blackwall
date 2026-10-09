---
name: start-task
description: 'Start working on a task from the backlog. Moves a task markdown file from /tasks/backlog/ to /tasks/in-progress/ and begins implementation. Use when beginning a new task, picking up work, or asked to "start", "begin", or "work on" a task. Accepts an optional task filename or description as argument; if omitted, runs pick-next-task to select automatically.'
argument-hint: 'Optional: task filename or description (e.g. "add-login.md" or "authentication")'
---

# Start Task

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. Code, task plans, and PR/commit text stay normal prose (caveman's own boundaries).

## When to Use

- User says "start a task", "begin working on", "pick up a task", or similar
- User provides a specific task file name or description as argument
- No argument given — use `pick-next-task` to select automatically (no manual scanning)

## Procedure

### 1. Identify the Task

**If an argument was given:**
- Find the matching file in `tasks/backlog/` (exact name or closest match by content/name)

**If no argument was given:**
- Run the picker script to select the next task:
  ```bash
  task=$(pwsh -File tasks/pick-next-task.ps1)
  ```
- If the script exits non-zero, the backlog is empty or all tasks are blocked — report this and stop
- Use the filename printed to stdout as the task to work on

### 2. Check Dependencies (manual-argument path only)

When a task was specified by argument (not selected by the script), read its first 20 lines and check its `depends_on:` frontmatter (or older `depends on:` line). If any listed dependency does not exist in `tasks/done/`, either start that dependency first or pick a different task.

*(When the script picks the task this check is already done — skip it.)*

### 3. Move the Task

```bash
mv tasks/backlog/<filename> tasks/in-progress/<filename>
```

Confirm the move succeeded before continuing.

### 4. Plan the Task

- Read the full task file
- Break the work into a checklist of implementation steps
- Save the plan as `tasks/in-progress/<filename>.plan.md` so progress survives context resets

### 5. Implement the Task

- Implement according to the checklist and the project conventions in `.github/copilot-instructions.md`
- Check off steps as you complete them
- When done, hand off to the `end-task` skill to finalise

## Notes

- Always read the full task file before writing any code
- Follow the project conventions in `.github/copilot-instructions.md`
- Task files are plain markdown — the first 20 lines are used by the picker for id and dependency metadata; priority and order come from the filename
