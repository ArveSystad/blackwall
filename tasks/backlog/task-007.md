---
id: task-007
title: Repo registry
status: backlog
depends_on: [task-003, task-004]
---

## Goal
The tool knows which local repos it may work on.

## Scope
- Add a single git repo path, or scan a root folder and register every git repo inside (bounded depth, skip `node_modules` and already-registered repos).
- Read the `origin` remote and resolve its connection (task-006).
- Per-repo check commands, auto-suggested from `package.json` scripts, `*.sln`/`*.csproj`, `Cargo.toml`, `go.mod` etc. Editable; empty = skip.
- Stale detection: when a repo is used and its path is gone, warn the user and remove it from the registry.

## Acceptance criteria
- Scanning a folder containing N git repos registers N entries.
- Deleting a repo folder and then using it shows a warning and removes it.

## Refs
grill-result.md §7, §3
