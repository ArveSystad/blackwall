---
id: task-010
title: Agent adapter interface + Claude Code adapter
status: backlog
depends_on: [task-004]
---

## Goal
Run Claude Code headless and normalize its output.

## Scope
- `AgentAdapter.run({ cwd, prompt, systemPrompt?, model?, resumeSessionId?, permissions, jsonSchema?, signal })` → `AsyncIterable<AgentEvent>` plus a final `{ sessionId, text, structured?, usage }`.
- Normalized `AgentEvent`: message, tool-call start/end, usage, error, result.
- Claude: `claude -p --output-format stream-json --verbose`, `--resume`, `--append-system-prompt`, `--model`, `--json-schema`, `--max-turns`, `--permission-mode` / `--allowedTools` / `--disallowedTools`.
- Process management: spawn with cwd, kill the process tree on abort (Windows-safe), capture stderr.
- Detect CLI presence and version at startup; show it in Settings.

## Acceptance criteria
- Unit tests over recorded stream-json fixtures.
- Abort kills the process tree on Windows and *nix.

## Refs
grill-result.md §1
