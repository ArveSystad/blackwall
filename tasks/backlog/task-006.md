---
id: task-006
title: Connections (GitHub/GHE, Jira Cloud) + missing-token modal
status: backlog
depends_on: [task-003, task-004, task-005]
---

## Goal
A named list of connections, resolved automatically per task.

## Scope
- CRUD for connections: `github` (github.com or any GHE host) and `jira` (Cloud only: base URL + email; API token in keychain).
- "Test connection": GitHub `GET /user`, Jira `GET /rest/api/3/myself`.
- Resolution: git remote host → GitHub connection; Jira base URL → Jira connection.
- Server error `MissingCredential { kind, host }` that the web app turns into the missing-token modal (enter token, save, retry the action).

## Acceptance criteria
- Starting an action against an unconfigured host opens the modal; saving the token retries successfully.

## Refs
grill-result.md §7
