---
name: blackwall-agent-cli
description: >
  How blackwall drives Claude Code, GitHub Copilot CLI and OpenCode headlessly: adapters, CLI flags, JSONL
  event parsing, normalized events, permission profiles, role prompts, seed agents, structured
  output and rate-limit detection. Use for ANY change in packages/core/src/agents/ — adding or
  changing a CLI flag, parsing a new event, changing permissions or what reviewers/implementers may
  run, editing system prompts or seed prompts, structured/JSON output, resume/session handling,
  rate limits; or when asked "add support for X in Claude/Copilot", "why did the agent get denied",
  "record a fixture".
---

# blackwall agent CLIs

blackwall spawns Claude Code, Copilot CLI and OpenCode headless inside the task worktree and normalizes their
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

## Trust

`AgentPermissions.trust` (an `AgentTrust` from `effectiveTrust`) decides each adapter's flags, config
and env. Locked is today's sandbox and every caller defaults to it (`LOCKED_TRUST`).

- **Claude, Trusted:** stays `--restricted` (it never loads project skills, agents, `CLAUDE.md` or
  `settings.json` itself, even with `--setting-sources project`). `prepareClaudeProject` copies
  `.claude/skills` and `.claude/agents/*.md` into a temp plugin (`--plugin-dir`, named
  `blackwall-project`; skills show as `blackwall-project:<name>`) and appends `CLAUDE.md` to
  `--append-system-prompt`. `Skill` (and `Agent` for read-only) join `--tools`; built-in
  sub-agents stay denied. Implementers with MCP on get `--mcp-config <cwd>/.mcp.json` (still
  `--strict-mcp-config`) plus `mcp__<name>` allows; with hooks on, the `hooks` of
  `.claude/settings.json` go in through `--settings`.
- **Claude guard hook (read-only Trusted):** `packages/core/hooks/guard-readonly.mjs` (outside `src`,
  found as `GUARD_READONLY_SCRIPT` from `src` and `dist`), a `PreToolUse` hook in `--settings`.
  `guardHookCommand` double-quotes `process.execPath` and the script with forward slashes (Git Bash,
  cmd and sh read it the same) and refuses `"`, `---
name: blackwall-agent-cli
description: >
  How blackwall drives Claude Code, GitHub Copilot CLI and OpenCode headlessly: adapters, CLI flags, JSONL
  event parsing, normalized events, permission profiles, role prompts, seed agents, structured
  output and rate-limit detection. Use for ANY change in packages/core/src/agents/ — adding or
  changing a CLI flag, parsing a new event, changing permissions or what reviewers/implementers may
  run, editing system prompts or seed prompts, structured/JSON output, resume/session handling,
  rate limits; or when asked "add support for X in Claude/Copilot", "why did the agent get denied",
  "record a fixture".
---

# blackwall agent CLIs

blackwall spawns Claude Code, Copilot CLI and OpenCode headless inside the task worktree and normalizes their
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

 or a backtick. The allowed Bash prefixes come
  from `readOnlyBashPrefixes` as `BLACKWALL_GUARD_ALLOW` in the spawn env, which the hook inherits;
  missing or malformed denies everything. A hook deny beats a skill's `allowed-tools`.
- **Claude, Unrestricted:** `--permission-mode bypassPermissions` and `--add-dir` only.
- **Copilot:** Locked adds `--excluded-tools=skill` (Copilot loads project skills, MCP and hooks by
  itself in a folder in the user's `trustedFolders`). Trusted keeps the skill tool (a skill's
  `allowed-tools` grants Copilot nothing) and adds `--add-dir <cwd>`; implementers with MCP on get
  `--additional-mcp-config @<cwd>/.mcp.json`. No per-run isolation from `~/.copilot` exists without
  hiding the login, so `TRUSTED_LOADS_GLOBAL_CONFIG` lists Copilot. Unrestricted: `--no-ask-user
  --allow-all`; implementers keep the worker plugin.
- **OpenCode:** Trusted keeps `OPENCODE_DISABLE_PROJECT_CONFIG=1` and the mirrored config home, adds
  `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` (else it loads `~/.claude/skills` and `~/.agents/skills`)
  and injects `opencodeProject`: `skills.paths`, `instructions`, the repo's agents with the run's
  permission, and for implementers `mcp` / `plugin` when on. Skills grant no permissions.
  Unrestricted drops the project-config switch and the config home and allows `*`.
- **Backstop:** read-only steps under Trusted are snapshotted and restored by the engine
  (`worktreeGuard`), see AGENTS.md.
- **Events:** `skills-loaded` comes from Claude's init `skills` (only with `Skill` in its tools) and
  Copilot's ephemeral `session.skills_loaded` (only when `reportSkills`, i.e. above Locked);
  OpenCode reports none. Fixtures: `<cli>/skills-locked.jsonl` and `<cli>/skills-trusted.jsonl`.
- **Spike outcomes (Claude 2.1.301, Copilot 1.0.98, OpenCode 1.19.0, Windows):** all of the above
  were confirmed live; `--add-dir` and `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` do not load
  project skills or `CLAUDE.md` under `--restricted`; `--mcp-config` and `--settings` hooks work
  under it.

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
