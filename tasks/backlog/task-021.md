---
id: task-021
title: Task list, task main view and new task form
status: backlog
depends_on: [task-008, task-014]
---

## Goal
The main UI described in grill-result.md §8.

## Scope
- Left: inbox task cards (origin/key, title, repo, stage progress, status, agents, time), needs-you first.
- Right: header with stage stepper; sections for Context, Plan (approve/request changes), Grill Q&A with inline answers, live Agent output with collapsible tool calls, Findings with force-fix/force-ignore, Diff (per round), Checks, Finish panel, free-text input bar.
- New task form: origin (Jira key/URL, PR URL + mode, free text), repo picker, free text, agents per role, reviewers, triage mode.
- Interrupted tasks show Resume; failed tasks show the error.

## Acceptance criteria
- A full task can be created, followed, answered, triaged and finished from the UI alone.

## Refs
grill-result.md §8, claude-design.md
