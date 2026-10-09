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

Within the same bucket, tasks are sorted by task number: the filename's leading digits (`0031-backlog-ui.md`, the current naming, see `create-task`) or the digits after `task-` in older files (`task-027-repo-backlog-storage.md`). Unnumbered files come last, alphabetically.
Files prefixed `proto-` are always ignored.

## Dependency Format

A task file may declare dependencies **in the first 20 lines**. The standard form is YAML frontmatter listing task ids:

```markdown
---
id: task-0032
depends_on: [task-0031, task-027]
---
```

A dependency matches a task by its frontmatter `id:` or by its filename (with or without `.md`). Older markdown forms still work:

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

A task with unmet dependencies is not picked; the script picks the first ready dependency still in `tasks/backlog/` instead, so prerequisites run first. A task whose dependency exists neither in `backlog/` nor `done/` is blocked and skipped.

## Procedure

Run the script and capture its output:

```bash
task=$(pwsh -File tasks/pick-next-task.ps1)
```

- **Exit 0 + stdout filename** — use that filename as the next task
- **Exit 1** — backlog is empty or every remaining task is blocked; stop the loop

## Notes

- The script reads only the first 20 lines of each file — keep `id:` and `depends_on:` near the top
- Dependency lookup is case-insensitive and strips backticks, asterisks, and surrounding whitespace
- The script never moves files; it only reads and reports
