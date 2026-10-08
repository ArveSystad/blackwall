---
id: task-019
title: Code review panel, findings and triage
status: backlog
depends_on: [task-012, task-014, task-018]
---

## Goal
Parallel reviewers, merged findings, user overrides.

## Scope
- Selected reviewers run in parallel, read-only, over the round's diff.
- Findings contract: severity, tags (from the tag list), file/lines, title, explanation, suggested fix.
- Aggregation step de-duplicates and merges findings.
- Critical + High gate the loop; Medium/Low go to the summary.
- User can force-fix or force-ignore any finding at any time.
- Triage modes: run-and-intervene (default) vs pause-each-round; final triage lets the user force-fix leftovers for one more round.

## Acceptance criteria
- Force-ignored blockers stop gating; force-fixed low findings are fixed in the next round.

## Refs
grill-result.md §5
