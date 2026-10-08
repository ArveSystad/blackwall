---
name: pick-next-task
description: 'Run the PowerShell task-picker script to deterministically select the highest-priority eligible task from tasks/backlog/. Outputs the filename. Used internally by start-task (when no argument is given) and by ralph.'
argument-hint: 'None'
---

# Pick Next Task

## Communication style

Follow the `caveman` skill for narration and status updates while running this — terse, no filler.

## Purpose

Executes `tasks/pick-next-task.ps1` to select the next task without spending tokens on analysis.
The result is a single filename on stdout — fully deterministic and free of LLM guesswork.

## Priority Order

| Bucket | Prefix | Example |
|---|---|---|
| 0 — highest | `simple-*` | `simple-fix-typo.md` |
| 1 | `standalone-*` | `standalone-reset-db-script.md` |
| 2 | `bugfix-*` | `bugfix-login-redirect.md` |
| 3 | `perf-*` | `perf-dashboard-query.md` |
| 4 | `sec-*` | `sec-xss-sanitize.md` |
| 5 — lowest | *(anything else)* | `refactor-button-styles.md` |

Within the same bucket, tasks are sorted alphabetically by filename.
Files prefixed `proto-` are always ignored.

## Dependency Format

A task file may declare dependencies **in the first 15 lines**:

```markdown
depends on: other-task.md
```

Multiple dependencies (comma- or semicolon-separated):

```markdown
depends on: task-a.md, task-b.md
```

Markdown formatting is stripped before parsing, so bold/code variants also work:

```markdown
**Depends on:** `task-a.md`, `task-b.md`
```

A task is considered **blocked** if any listed dependency file does not exist in `tasks/done/`.
Blocked tasks are silently skipped; the script moves on to the next eligible candidate.

## Procedure

Run the script and capture its output:

```bash
task=$(pwsh -File tasks/pick-next-task.ps1)
```

- **Exit 0 + stdout filename** — use that filename as the next task
- **Exit 1** — backlog is empty or every remaining task is blocked; stop the loop

## Notes

- The script reads only the first 15 lines of each file — keep `depends on:` near the top
- Dependency lookup is case-insensitive and strips backticks, asterisks, and surrounding whitespace
- The script never moves files; it only reads and reports
