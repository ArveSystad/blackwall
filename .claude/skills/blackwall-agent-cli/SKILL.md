---
name: blackwall-agent-cli
description: >
  How blackwall drives Claude Code and GitHub Copilot CLI headlessly: adapters, CLI flags, JSONL
  event parsing, normalized events, permission profiles, role prompts, seed agents, structured
  output and rate-limit detection. Use for ANY change in packages/core/src/agents/ — adding or
  changing a CLI flag, parsing a new event, changing permissions or what reviewers/implementers may
  run, editing system prompts or seed prompts, structured/JSON output, resume/session handling,
  rate limits; or when asked "add support for X in Claude/Copilot", "why did the agent get denied",
  "record a fixture".
---

# blackwall agent CLIs

blackwall spawns Claude Code and Copilot CLI headless inside the task worktree and normalizes their
JSONL output into one event stream. Every agent must behave the same on either CLI: same events,
same structured results, same permission boundary. All paths below are under
`packages/core/src/agents/`.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, prompts and commit text stay normal prose.

## Sources of truth

1. **Adapters:** `adapters/claude.ts` (`claudeArgs`, `createClaudeParser`) and `adapters/copilot.ts`
   (`copilotArgs`, `copilotPrompt`, `createCopilotParser`) are authoritative for CLI flags. Do not
   trust docs or memory over them.
2. **Normalized types:** `adapters/types.ts` (`AgentEvent`, `AgentResult`, `AgentRunOptions`,
   `AgentRunError`, `AgentRunFailure`). New CLI behaviour maps onto these. Extend the types only if
   the behaviour cannot be expressed with them, and then for both CLIs.
3. **Fixtures:** recorded runs in `adapters/fixtures/<claude|copilot>/*.jsonl` show what each CLI
   actually emits.

## Procedure for adding or changing CLI behaviour

1. Record a real run with the CLI's JSONL output into
   `adapters/fixtures/<claude|copilot>/<case>.jsonl`. Trim it, but keep it real; never hand-write
   events the CLI does not emit.
2. Parse-test it in `adapters/claude.test.ts` or `adapters/copilot.test.ts`: `createClaudeParser` /
   `createCopilotParser` must produce the expected `AgentEvent[]`.
3. Replay-test it through the adapter with `adapters/fixtures/fake-cli.js replay <fixture>`. Other
   modes: `replay-resume`, `echo`, `copilot-echo`, `fail`, `limit`, `hang`.
4. Keep the Claude/Copilot equivalence tests in `adapters/copilot.test.ts` passing: "yields the same
   normalized events as Claude for the same task" and "matches Claude's structured result for the
   same task" (both compare via `normalized()`). When you add a case to one CLI, add the matching
   case to the other.
5. Check: `pnpm typecheck && pnpm lint && pnpm test`.

## Structured output

- **Claude:** `--json-schema` with the `$schema` dialect stripped (`withoutDialect` in
  `adapters/claude.ts`), because Claude's validator rejects it. Fixture: `claude/json-schema.jsonl`.
- **Copilot:** no native flag. `copilotPrompt` appends `structuredOutputContract` (a fenced JSON
  block). `withStructuredOutput` in `adapters/structured-output.ts` parses the answer and allows
  exactly one repair turn on the same session, using `structuredOutputRepairPrompt`. A second invalid
  answer fails with `invalid-output`. Fixtures: `copilot/json-block.jsonl`, `copilot/json-repair.jsonl`.

## Permissions

- Profiles (`read-only`, `implement`) become CLI flags in `permissions.ts`: `permissionsFor` builds
  the rules, `permissionArgs` emits the flags for each CLI.
- Reviewers are read-only: read tools plus `SAFE_GIT_COMMANDS`.
- Implementers may edit and use the shell, but never push, touch remotes or run `gh`.
  `REMOTE_COMMANDS` is denied for every profile.
- Agent overrides can widen allow (e.g. a test command for a reviewer) but never lift a deny.
- Everything stays confined to the worktree.
- Unit tests: `permissions.test.ts`. Live check: `cli-permissions.test.ts`, which proves the real
  CLIs enforce the flags. Update both when the rules change.

## Prompts and seeds

- System prompts and output contracts live in `prompts.ts` (`buildSystemPrompt`, `planContract`,
  `questionsContract`, `findingsContract`, `PLAN_SECTIONS`).
- Seed agents live in `seeds.ts` (`SEED_AGENTS`).
- Unedited seed prompts upgrade on start. When changing a seed prompt, append the old text to
  `LEGACY_SEED_PROMPTS` so `upgradeSeedPrompts` in `service.ts` replaces it. Prompts the user edited
  are left alone.

## Rate limits

- Detection lives in `adapters/rate-limit.ts`: `claudeRateLimitFromEvent`, `claudeRateLimitFromText`
  and `copilotRateLimitFromText`.
- Fixtures: `claude/rate-limited.jsonl` and the `fake-cli.js limit` mode, tested in
  `adapters/rate-limit.test.ts`.
- Backoff happens in `quota.ts`.

## Live tests

- Opt-in: `BLACKWALL_TEST_CLIS=1 pnpm test`.
- `contracts.cli.test.ts` checks that seed prompt output contracts parse on both real CLIs;
  `cli-permissions.test.ts` covers permissions.
- They need both CLIs installed and logged in, and they spend real model calls. Run them after
  changing flags, prompts, contracts or permissions.

## Keeping this skill current

When adapter flags, events, permissions, prompts or the fixture workflow change, update this skill
in the same commit so it never contradicts the code.
