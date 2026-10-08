---
id: task-020
title: Summarize + finish/delivery confirmation
status: backlog
depends_on: [task-013, task-015, task-016, task-019]
---

## Goal
Wrap up a task and do outward actions only after confirmation.

## Scope
- Summarizer writes the final summary (changes, decisions, leftover Medium/Low findings).
- Optional squash.
- Pre-ticked delivery actions shown with exact targets: push branch, open PR (Jira tasks), PR comment, Jira comment. No Jira transitions.
- Free-text tasks: rebase + ff into local `main`; never push `main`.
- Review PR mode: user selects findings to post as inline review comments.

## Acceptance criteria
- Nothing leaves the machine without the user confirming that specific action.

## Refs
grill-result.md §3, §4
