# blackwall: grill results

A locally running TypeScript tool with a browser UI for orchestrating coding agents (Claude Code and GitHub Copilot CLI), where agents plan, implement, review and grill each other's work. Tasks come from Jira Cloud, GitHub/GHE pull requests or free text, and run against local git repos. All auth is via personal access tokens.

Grilled 2026-10-08. This covers the foundation; refinements come later.

## 1. Agent runtime

- Agents run as **headless background CLI subprocesses**. No SDK, no PTY.
- v1 adapters: **Claude Code** and **GitHub Copilot CLI**, behind a common `AgentAdapter` interface.
- Each step is a non-interactive invocation that streams structured output; follow-ups resume the CLI session.

| | Claude Code (2.1.x) | Copilot CLI (1.0.x) |
|---|---|---|
| Headless | `-p` | `-p` |
| Output | `--output-format stream-json --verbose` | `--output-format json` (JSONL events) |
| Resume | `--resume <id>` / `--session-id` | `--resume <id>` / `--session-id` |
| System prompt | `--append-system-prompt` | none; put the role prompt in the prompt body |
| Structured output | `--json-schema` | none; enforce in prompt, parse defensively, retry once |
| Permissions | `--permission-mode`, `--allowedTools`, `--disallowedTools` | `--allow-tool`, `--deny-tool`, `--no-ask-user` |
| Model | `--model` | `--model` |
| Working dir | spawn `cwd` | `-C <dir>` / spawn `cwd` |
| Auth | existing Claude login | existing login, or `COPILOT_GITHUB_TOKEN` + `GH_HOST`/`COPILOT_GH_HOST` for GHE |

Copilot notes: drop `ephemeral` and delta events; final text comes from the last `assistant.message`; the `result` event carries `sessionId` and usage.

Later: a "take over" button that resumes a session in an interactive PTY.

## 2. Domain model

- **Task** = one **origin** + one **workspace** + delivery targets + one or more **Runs**.
  - Origin: `jira-issue` | `github-pr` | `free-text`.
  - Workspace: a repo from the registry, plus a per-task git worktree.
  - Delivery targets: push branch, open PR, PR comment / review, Jira comment.
- **Run** = one pass of the pipeline; made of **Steps** (stage, agent, CLI session id, status, event log).
- **Finding** = reviewer agent, severity, tags[], file + line range, title, explanation, optional suggested fix, status (open / fixed / force-fix / force-ignore).
- **Agent** (library entry) = name, CLI, model, prompt/persona, eligible stages, permission overrides.
- **Connection** = name, kind (`github` | `jira`), base URL, auth metadata. The secret itself lives in the keychain.
- **Repo** = path, remote URL, resolved connection, check commands.

## 3. Pipeline (hardcoded)

```
Inform ──► Plan review / grill ──► [human plan approval] ──► Implement ──► Checks ──► Code review panel
                                                              ▲                                 │
                                                              └──── blocking findings (≤3) ◄────┘
                                                                                                 │ approved
                                                                                                 ▼
                                                                              Summarize ──► [human finish confirm]
```

- **Inform**: gather origin context and the user's free text, read the repo, and write a rough plan.
  - Jira: summary, description, type, comments, linked issues, parent/epic, subtasks, and image/PDF/text attachments (size-capped, downloaded to an ignored scratch folder in the worktree).
  - Work on PR: PR description, diff, review comments, and the linked Jira issue if a key is in the branch or title and a Jira connection exists.
- **Plan review / grill**: a reviewer panel grills the plan. The planner answers questions the repo can answer. Questions that need a human decision go to the user in the UI. The user approves the final plan before any code is touched.
- **Implement**: the implementer writes code in the worktree.
- **Checks**: the harness runs per-repo check commands (build/test, auto-suggested from `package.json`, `*.sln` etc.; empty = skip). A failure goes back to the implementer before reviewers run, and becomes a Critical `correctness` finding if it persists.
- **Code review loop**: see §5.
- **Summarize / finish**: the summarizer writes the summary, the user confirms delivery actions (§4).

### PR task modes (chosen at creation)

- **Work on PR**: the full pipeline; commits go to the PR branch.
- **Review PR**: inform → reviewer panel → triage → the selected findings are posted as inline PR review comments. No plan/implement stages.

## 4. Git, worktrees and delivery

- **One worktree per task**, created next to the repo (e.g. `../<repo>.worktrees/<task>`):
  - PR: the PR head branch.
  - Jira: a new branch `feature/abc-123-short-summary`, or `fix/…` when the issue type is Bug. The slug comes from the issue title.
  - Free text: temp branch `agent/<task-id>`. At finish: rebase onto `main`, then `git merge --ff-only` into local `main`. On a conflict, the implementer resolves it in the worktree and the rebase continues; if it cannot, the rebase is aborted and the user is asked.
- **The harness commits**, not the agents: one commit after each implement/fix round. The summarizer writes the message, prefixed with the Jira key when there is one. Optional squash-at-finish.
- **Agents never push.** At finish the user confirms pre-ticked actions, showing exactly what will be sent:
  - PR (work): push to the PR branch, post a summary comment.
  - Jira: push the branch, open a PR on GitHub/GHE, post a summary comment on the Jira issue.
  - Free text: local `main` only. **Never push `main`.**
  - No Jira transitions in v1.

## 5. Agents, reviews and findings

- **Agent library** (Settings): add, edit and remove agents. Seeded with planner, implementer, summarizer and reviewers (UX/design, security, code quality, performance, …).
- **Role defaults** per stage (planner, plan reviewers, implementer, code reviewers, summarizer) in Settings, overridable on the new-task form. Default to mixed vendors between author and reviewer.
- **Permissions**: role-scoped allowlists by default, with per-agent overrides.
  - Reviewers are read-only (read/grep/glob plus safe git like `git diff`/`git log`).
  - Implementers get edit + shell, but `git push`, `gh` and anything touching remotes is denied.
  - Agents are confined to the worktree.
- **Review panel**: the selected reviewers run in parallel over the same diff, then an aggregation step merges and de-duplicates their findings.
- **Severity**: Critical / High / Medium / Low. **Critical + High gate the loop** (fixed rule). Medium and Low go to the summary unless the user force-fixes them.
- **Tags**: an editable list in Settings, injected into reviewer prompts. Seed list: `security`, `correctness`, `ux`, `accessibility`, `design`, `performance`, `code-quality`, `maintainability`, `architecture`, `testing`, `error-handling`, `concurrency`, `data`, `api-contract`, `dependencies`, `config`, `observability`, `documentation`, `spelling`, `i18n`, `plan-deviation`, `scope-creep`.
- **Loop cap**: 3 fix rounds, then escalate to the user.
- **User overrides**: force-fix or force-ignore any finding, at any severity.
- **Triage mode** (per-task toggle):
  - *Run and let me intervene* (default): the loop proceeds on the default triage, overrides apply from the next round, and a final triage screen lets the user force-fix leftovers (one more round).
  - *Pause each round*: wait for the user to triage before each fix round.

## 6. Concurrency and resilience

- Max **3 concurrent tasks per repo** (configurable). Different repos run independently. **One active task per branch.**
- Tasks waiting on the user (questions, plan approval, finish, escalation) don't occupy a slot.
- Shutdown or crash: kill the child CLIs. On restart, in-flight steps are **interrupted**, and **Resume** re-runs the step with `--resume <sessionId>` in the same worktree.
- All step state, session ids and event logs are persisted to SQLite as they stream.

## 7. Connections, secrets and repos

- **Connections**: a named list. Any number of GitHub.com / GHE hosts. **Jira Cloud only** (email + API token, REST v3, ADF for descriptions/comments).
- A task resolves its connection automatically from the git remote host or the Jira base URL.
- **Secrets**: OS keychain via `@napi-rs/keyring`. SQLite stores only "token set ✓" metadata.
  - Env var overrides for headless use (e.g. `BLACKWALL_JIRA_TOKEN`).
  - Tokens are never sent to the browser.
- **Missing PAT modal**: shown when an action needs a connection or token that doesn't exist.
- **Repo registry**:
  - Add repos one at a time, or point at a root folder to register every git repo inside it.
  - A repo that no longer exists on disk triggers a warning when used and is removed from the registry.
  - Jira tasks always ask which repo (nothing is remembered per project key).

## 8. UI

- **Two-pane main screen**:
  - Left: inbox-style task list. Cards show simple status metadata, with needs-you tasks sorted to the top.
  - Right: main view for the selected task: details, stage progress, grill questions and answers, free-text input, live agent output, plan, findings with force-fix/force-ignore, diff, finish confirmation.
- **New task** form: origin, repo, mode, agents per role, reviewers, triage mode, free text.
- **Settings**: connections (PATs), repo registry (+ check commands), agent library, tags, role defaults, concurrency cap.
- **Notifications**: in-app only. A needs-you badge, a count in the tab title (`(2) blackwall`), and sort order.
- **Look**: dense dev-tool style (Linear / GitHub / VS Code). Follows the system theme. Dark: cyberpunk deep blue-purple with glowing neon accents, muted off-white text, conventional green/red diffs. Light: clean and generic. See `claude-design.md`.

## 9. Tech stack and architecture

```
blackwall/
├─ apps/
│  ├─ server/          Node 22+, Hono, WebSocket, serves built SPA
│  └─ web/             React + Vite, TanStack Router + Query, Tailwind + shadcn/ui
├─ packages/
│  ├─ core/            domain, pipeline engine, scheduler, git/worktree service, CLI adapters
│  ├─ integrations/    Jira Cloud client, GitHub/GHE client (Octokit)
│  └─ shared/          types + zod schemas shared by server and web
└─ tasks/backlog/      planning tasks
```

- pnpm workspaces, TypeScript strict, Vitest. CLI adapters are tested against recorded JSONL fixtures.
- SQLite via `better-sqlite3` + Drizzle, stored at `~/.blackwall/blackwall.db`.
- A single local process bound to `127.0.0.1`, with a random per-launch token in the URL to guard against other local processes, CSRF and DNS rebinding.
- Launch: clone, then `pnpm start` (builds if needed, opens the browser). README describes PowerShell-profile and bash/zsh launcher functions.

## 10. Deferred / later

- Interactive PTY take-over of an agent session.
- Cloning repos from the tool.
- npm distribution. The unscoped `blackwall` name is taken on npm, so use a scoped name (e.g. `npx @<scope>/blackwall`).
- Jira transitions; Jira Data Center.
- Addressing review comments on your own PR as a dedicated flow (partly covered by Work on PR).
- Desktop notifications / sound.
- Configurable gating threshold.
- More CLIs (codex, gemini, …).
- Tag list expansion.
