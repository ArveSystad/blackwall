---
id: task-015
title: Jira Cloud client + Inform for Jira tasks
status: backlog
depends_on: [task-006, task-014]
---

## Goal
Turn a Jira issue into agent context.

## Scope
- REST v3 with email + API token (Basic).
- Fetch summary, description, issue type, comments, linked issues, parent/epic, subtasks.
- ADF → markdown for descriptions/comments; markdown → ADF for posting comments.
- Download image/PDF/text attachments (size-capped) into an ignored scratch folder in the worktree.
- Accept a key or an issue URL.

## Acceptance criteria
- Recorded-fixture tests for ADF conversion and issue assembly.

## Refs
grill-result.md §3, §7
