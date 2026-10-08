---
id: task-016
title: GitHub/GHE client + Inform for PR tasks
status: backlog
depends_on: [task-006, task-014]
---

## Goal
Turn a PR into agent context, and deliver results back.

## Scope
- Octokit with per-connection base URL (github.com or GHE `/api/v3`).
- Parse PR URLs; match `owner/repo` against the repo registry (ask to register if missing).
- Fetch PR description, diff, review comments; detect a Jira key in branch/title and pull the issue when a Jira connection exists.
- Delivery: open PR, post PR comment, post a review with inline comments.

## Acceptance criteria
- Fixture tests for PR context assembly and review-comment payloads.

## Refs
grill-result.md §3, §4
