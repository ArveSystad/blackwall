---
id: task-011
title: GitHub Copilot CLI adapter
status: backlog
depends_on: [task-010]
---

## Goal
Copilot as a second, interchangeable agent backend.

## Scope
- `copilot -p --output-format json --no-ask-user`, `--resume`/`--session-id`, `--model`, `-C`, `--allow-tool`/`--deny-tool`.
- Map JSONL events (`assistant.message`, `tool.execution_start/complete`, `result`, …); drop `ephemeral` and delta events; final text = last `assistant.message.content`.
- No system-prompt flag: prepend the role prompt to the prompt body.
- No JSON-schema flag: structured output via a prompt contract (fenced JSON block), zod-validated, one repair retry.
- Pass `COPILOT_GITHUB_TOKEN` / `COPILOT_GH_HOST` from a connection when configured.

## Acceptance criteria
- Fixture-based tests; equivalent runs yield the same normalized events as the Claude adapter.

## Refs
grill-result.md §1
