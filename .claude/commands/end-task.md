---
name: end-task
description: 'Finish and close a task that is in progress. Moves a task markdown file from /tasks/in-progress/ to /tasks/done/, then appends a summary line to /tasks/done.md. Use when a task is fully complete, or when asked to "finish", "complete", "close", or "end" a task.'
argument-hint: 'Optional: task filename or description (e.g. "add-login.md")'
---

# End Task

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. The `done.md` summary line stays normal prose (caveman's own boundaries).

## When to Use

- A task implementation is complete and needs to be closed out
- User says "end task", "finish task", "mark as done", "complete task", or similar
- Called naturally at the end of a `start-task` workflow

## Procedure

### 1. Identify the Task

- If an argument is given: find the matching file in `tasks/in-progress/`
- If no argument and only one file is in `tasks/in-progress/`: use that file
- If multiple in-progress tasks exist: ask the user which one to close

### 2. Move the Task File

Run in the terminal:

```
mv tasks/in-progress/<filename> tasks/done/<filename>
```

### 3. Update `/tasks/done.md`

- Read `tasks/done.md` to find the current highest sequence number (the `##.` prefix on each entry below the `---` line)
- Append a new line in the format:

```
<N+1>. <One-line summary of what was accomplished>
```

Where `N` is the current highest number (or `1` if there are no entries yet). The summary should concisely describe the completed work in past tense (e.g. "Added user authentication with JWT tokens").

- The new line goes at the **end** of the file, after all existing entries

### 4. Confirm Completion

- Confirm the task file has been moved to `tasks/done/`
- Confirm `tasks/done.md` has been updated with the new entry
- If there's a `<task name>.plan.md` file in the in-progress directory, delete it.

## Notes

- The sequence number in `done.md` is a simple incrementing integer — always check the current max before appending
- Write the summary from the perspective of what was delivered, not what was planned
- Keep summaries to a single line, matching the style of existing entries in `done.md`
