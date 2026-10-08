---
id: task-013
title: Git/worktree service
status: backlog
depends_on: [task-007]
---

## Goal
All git operations the pipeline needs, via the git CLI.

## Scope
- Create a worktree per task next to the repo (`../<repo>.worktrees/<task>`).
- Branch rules: PR → PR head branch; Jira → `feature/<key>-<slug>` or `fix/<key>-<slug>` when issue type is Bug; free text → `agent/<task-id>`.
- Commit after each implement/fix round (`git add -A`, message supplied by caller); optional squash at finish.
- Free-text finish: rebase onto `main`, `git merge --ff-only` into local `main`; on conflict, stop and report.
- Push (harness only), diff per round, cleanup/remove worktree.

## Acceptance criteria
- Integration tests against temp repos for every branch rule, commit, squash, rebase/ff and conflict path.
- Never pushes `main`.

## Refs
grill-result.md §4
