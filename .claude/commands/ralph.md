---
name: ralph
description: 'Run an autonomous loop that works through tasks/backlog/ one at a time, each in a fresh agent session. Starts the highest-priority task, implements it, commits, then repeats. Stops when the backlog is empty, on any error, or when manually interrupted.'
argument-hint: 'Optional: max number of tasks to run (e.g. "3")'
---

# Ralph Loop

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. Pass this instruction on to each spawned sub-agent too.

## When to Use

- User says "ralph", "ralph loop", "start ralph", or "work through the backlog"
- Autonomous batch task processing is needed
- For multiple tasks worked concurrently in isolated worktrees, use `ralph-parallel` instead — this skill is strictly one task at a time, sequentially.

## Procedure

### 0. Read the Argument

If an argument was given and it is a positive integer N, stop after completing N tasks even if the backlog still has items. Otherwise run until the backlog is empty or an error occurs.

### 1. Pick the Next Task

Run the picker script:

```bash
task=$(pwsh -File tasks/pick-next-task.ps1)
```

- **Exit 0:** `$task` contains the filename — continue to step 2
- **Exit 1:** backlog is empty or all remaining tasks are blocked — print "Backlog is empty — ralph loop complete." and stop

The script handles all priority ordering and dependency checks deterministically. Do not re-analyse the backlog yourself.

### 2. Launch a Fresh Agent

Spawn a new sub-agent (via the Agent tool) with the prompt below, substituting `<task-file>` with the value of `$task`:

---

> You are working on the JoinIn codebase at C:\Code\joinin.no.
>
> Your job is to complete exactly one task, then commit the work. Follow these steps in order:
>
> 1. Use the `start-task` skill with argument `<task-file>`. It will move the task to in-progress and give you the full requirements — read them carefully before writing any code.
> 2. Implement the task fully, following the project conventions in `.github/copilot-instructions.md` and `.github/design.md`.
> 3. Use the `end-task` skill to move the task file to `tasks/done/` and update `tasks/done.md`.
> 4. Use the `commit` skill to commit all changes with a well-structured conventional commit message.
>
> If any step fails, stop immediately and report the error clearly. Do not skip or reorder steps.

---

Wait for the agent to finish before continuing.

### 3. Evaluate the Result

- **Error / incomplete:** print the error message and **halt the loop entirely**. Do not attempt the next task.
- **Success:** print a one-line summary (`✓ <task-file>: <what was done>`), decrement the remaining task count if a limit was set, then continue to step 1.

### 4. Repeat

Go back to step 1. The loop ends when:

- The picker script exits non-zero (backlog empty or all blocked)
- An agent errors out (halt)
- The task limit (from the argument) is reached
- An API, budget, or session limit is hit — these surface as errors and trigger the halt path
- The user manually interrupts

## Notes

- Each task runs in its own Agent call with a clean context — no bleed between tasks
- Tasks run strictly one at a time; never parallelize
- Never skip the commit step, even for trivial changes
- Task file moves and `done.md` updates performed by `end-task` should be folded into the same commit as the implementation (the `commit` skill handles this)
- The picker script (`tasks/pick-next-task.ps1`) is the single source of truth for task priority — do not override its selection
