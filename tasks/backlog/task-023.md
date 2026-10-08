---
id: task-023
title: Launch command and README launcher functions
status: backlog
depends_on: [task-002]
---

## Goal
Start the tool with one word from any shell.

## Scope
- `pnpm start`: build if output is missing or stale, then start the server and open the browser; supports `--no-open` and `--port`.
- README: PowerShell profile function and bash/zsh function (already drafted in README.md); verify both work.

## Acceptance criteria
- `blackwall` launches the tool from any directory on Windows (PowerShell) and macOS/Linux (bash/zsh).

## Refs
grill-result.md §9, README.md
