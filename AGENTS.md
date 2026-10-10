# AGENTS.md

Guidance for coding agents working in this repo.

## What this is

blackwall is a local, single-user, browser-based control room that runs Claude Code and GitHub Copilot CLI as headless subprocesses against the user's git repos. Agents run on either CLI and plan, grill, implement and review each other's work on tasks from Jira Cloud, GitHub/GHE PRs and issues, or Blackwall tasks you write yourself (free text); the user approves plans, answers questions, triages findings and confirms every outbound action.

This file plus the code are the design reference. User-facing docs are in [`README.md`](README.md).

## Layout

- `apps/server`: Hono HTTP + WebSocket on 127.0.0.1 with launch-token auth (`auth.ts`). Serves the built SPA; routes are wired in `app.ts`.
- `apps/web`: React + Vite, TanStack Router + Query, Tailwind v4 + shadcn/ui.
- `packages/core`:
  - `pipeline/`: engine, transitions, scheduler, backlog runner, delivery.
  - `agents/`: CLI adapters (`adapters/`, with recorded JSONL fixtures), prompts, permissions and seeds. The adapters are the source of truth for CLI flags.
  - `git/`, `repos/`, `connections/`, `secrets/`, `settings/`.
  - `db/`: SQLite via better-sqlite3 + Drizzle; migrations in `packages/core/drizzle/`.
- `packages/integrations`: Jira Cloud and GitHub/GHE (Octokit) clients, with fixtures.
- `packages/shared`: zod domain and protocol schemas shared by server and web.
- `scripts/start.js`: the `pnpm start` launcher. `start.ps1`: the dev launcher on Windows.
- `docs/design/`: UI mockups; `bw.css` is the token source.

## Commands

- `pnpm install`
- `pnpm dev`: server under `tsx watch` plus the Vite dev server.
- `pnpm build`
- `pnpm typecheck`
- `pnpm test`: Vitest against sources, no build needed.
- `pnpm lint`
- `pnpm format:check` (`pnpm format` to fix).
- Real-CLI and keyring tests are opt-in: `BLACKWALL_TEST_CLIS=1`, `BLACKWALL_TEST_KEYRING=1`.
- Before finishing a change, run `pnpm typecheck && pnpm lint && pnpm test`.

## Conventions

- TypeScript strict, ESM, Node 22+.
- Prettier: width 100, double quotes, trailing commas. LF line endings, 2-space indent (`.editorconfig`).
- Tests sit next to sources as `*.test.ts`.
- Shared types and schemas go in `packages/shared`.
- A DB schema change needs a new Drizzle migration (`packages/core/drizzle.config.ts`).
- Match the surrounding comment density and naming.
- UI work follows [`.claude/skills/blackwall-design/SKILL.md`](.claude/skills/blackwall-design/SKILL.md).

## Design rules

- **Domain:** a Task has one origin (`jira-issue` | `github-pr` | `github-issue` | `free-text`, shown as "Blackwall") and one or more Runs; Runs are made of Steps; Findings carry a severity and tags.
- **Agents:** CLI-agnostic. A task runs its agents on its repo's default CLI (copied onto the task when it is created), with optional per-agent overrides per task. Each step records the CLI it ran on. Models and permission overrides are set per CLI on the agent.
- **Pipeline:** Inform → Plan review/grill → plan approval → Implement → Checks → Code review → Summarize → finish. Review PR mode: Inform → review panel → triage → inline PR comments, no plan or implement. Summarize may propose up to 5 follow-up tasks, stored on the task; a task that only analyses code may change nothing and deliver its follow-ups as its whole output.
- **Checks:** per-repo commands run after each implement round; a failure goes back to the implementer and becomes a Critical `correctness` finding if it persists.
- **Grill:** plan reviewers ask questions; the planner answers what the repo can settle, the rest go to the user. Nothing is implemented before the user approves the plan.
- **Worktrees:** one per task at `../<repo>.worktrees/<task>`.
- **Branches:** PR tasks use the PR head branch. Jira tasks use `feature/<key>-<slug>`, or `fix/…` when the issue is a Bug. GitHub issue tasks use `feature/<number>-<slug>`, or `fix/…` when the issue has a `bug` label. Blackwall (`free-text`) tasks use `agent/<task-id>`, then rebase and `merge --ff-only` into local `main` at finish.
- **Commits:** the harness commits once per implement/fix round, not the agents; the message is prefixed with the Jira key when there is one.
- **Delivery:** only at finish, after explicit confirmation of each listed action. No Jira transitions. GitHub issue tasks push, open a PR whose body ends `Closes owner/repo#n`, and comment on the issue (`issue-comment`). GitHub issue tasks may also comment on the issue when created and at plan approval. Each comment is opted into and confirmed by the user, never posted by an agent, and is logged on an existing step rather than a new one. Delete is refused while a plan-approval comment is posting.
- **Follow-up tasks:** `create-tasks` is a delivery action like the others, offered last (after `merge-main`) when Summarize proposed follow-ups, with a checkbox per item and its target repo. Nothing is created until the user confirms; the picked items are added in one transaction as independent free-text `waiting` backlog items (`dependsOn: []`, `sourceTaskId` set), and `backlog.changed` lets each repo's runner pick them up. Follow-ups must stand alone; multi-step work chains because a follow-up's description lists the later steps and its own Summarize proposes them as its follow-ups. A branch with no commits of its own offers no push, PR or merge.
- **Findings:** Critical and High gate the loop. At most 3 fix rounds, then escalate to the user. The user can force-fix or force-ignore any finding at any severity.
- **Permissions:** reviewers are read-only (read tools + safe git). Implementers can edit and use the shell, but `git push`, `gh` and anything touching remotes is denied. All agents are confined to the worktree.
- **Concurrency:** up to 3 tasks per repo by default (configurable); one active task per branch. Tasks waiting on the user don't hold a slot.
- **Resume:** on shutdown the child CLIs are killed; in-flight steps become interrupted and resume with `--resume <sessionId>` in the same worktree.

## Hard rules

- Bind only to 127.0.0.1.
- Tokens live in the OS keychain or `BLACKWALL_TOKEN_*` env vars. They are never sent to the browser or stored in SQLite.
- Agents never push, and `main` is never pushed.

## Task workflow

- Work items move `tasks/backlog/` → `tasks/in-progress/` → `tasks/done/`, named `NNNN-short-summary.md` with frontmatter. The folders are created on demand.
- When a task is done, append an entry to [`tasks/done.md`](tasks/done.md).
- Slash commands for this live in [`.claude/commands/`](.claude/commands/).
