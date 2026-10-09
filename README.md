# blackwall

A local, single-user, browser-based control room for coding agents. blackwall runs Claude Code and GitHub Copilot CLI as headless subprocesses against your own git repos. Tasks come from Jira Cloud issues, GitHub/GHE pull requests (Work on PR or Review PR) or free text.

Agents from different vendors plan, grill, implement and review each other's work. You approve the plan, answer the questions only you can answer, triage the findings and confirm every outbound action.

The name comes from the Blackwall in Cyberpunk 2077, the barrier that keeps rogue AIs contained. Here you are the wall: agents work freely inside their worktrees, but nothing leaves the machine without your say-so.

> Status: in active development; the v1 pipeline works. See [`AGENTS.md`](AGENTS.md) for architecture and design rules, [`tasks/done.md`](tasks/done.md) for what's built and [`docs/design/`](docs/design/README.md) for the UI mockups.

## How it works

```
Inform ──► Plan review / grill ──► [human plan approval] ──► Implement ──► Checks ──► Code review panel
                                                              ▲                                 │
                                                              └──── blocking findings (≤3) ◄────┘
                                                                                                 │ approved
                                                                                                 ▼
                                                                              Summarize ──► [human finish confirm]
```

- Review PR mode runs Inform → review panel → triage → inline PR review comments.
- Each task gets its own git worktree at `../<repo>.worktrees/<task>`.
- The harness commits after each implement or fix round. Agents never push, and `main` is never pushed.
- Critical and High findings loop back to the implementer, for at most 3 fix rounds before escalating to you.
- Reviewers are read-only. Implementers can edit and use the shell but cannot reach remotes.
- A per-repo backlog with an auto-runner that respects concurrency caps and CLI usage limits.
- Interrupted steps resume the same CLI session.

## Features

- Agent library with role defaults per stage
- Finding tags and severities, with force-fix and force-ignore on any finding
- Connections to GitHub.com, GHE and Jira Cloud, with tokens in the OS keychain
- Repo registry with auto-suggested check commands
- Live agent output and per-round diffs
- Needs-you inbox, with the count in the tab title
- Dark and light themes
- Keyboard shortcuts

## Not yet

Interactive PTY take-over of an agent session, cloning repos from the tool, npm distribution, Jira transitions and Jira Data Center, desktop notifications and more CLIs.

## Requirements

- Node.js 22+ and pnpm
- git
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://code.claude.com) (`claude`)
  - [GitHub Copilot CLI](https://docs.github.com/en/copilot) (`copilot`)

## Running

```sh
git clone <this repo> ~/code/blackwall
cd ~/code/blackwall
pnpm install
pnpm start          # builds if output is missing or stale, starts on 127.0.0.1 and opens your browser
```

`pnpm start -- --no-open` skips opening the browser. `pnpm start -- --port 4711` picks a port (default 4711, or `BLACKWALL_PORT`). The build is skipped when nothing under the workspace sources or config has changed since the last `pnpm start` build.

The server binds to `127.0.0.1` only and prints a URL containing a per-launch token. Data lives in `~/.blackwall/`; `BLACKWALL_HOME` overrides the data directory. Personal access tokens are stored in your OS keychain, never in the database.

For headless use, set `BLACKWALL_TOKEN_<CONNECTION>` to override a connection's keychain token. The suffix is the connection name in upper case with other characters replaced by `_`, so `jbf.ghe.com` reads `BLACKWALL_TOKEN_JBF_GHE_COM`.

## Quick-launch function

Add a one-word launcher to your shell profile so `blackwall` starts the tool from anywhere.

### Windows (PowerShell)

Open your profile with `notepad $PROFILE` and add:

```powershell
function blackwall {
    pnpm --dir "C:\Code\blackwall" start -- @args
}
```

### macOS / Linux (bash or zsh)

Add to `~/.bashrc` or `~/.zshrc`:

```sh
blackwall() {
  pnpm --dir "$HOME/code/blackwall" start -- "$@"
}
```

Replace the path with where you cloned the repo. Restart the shell (or `. $PROFILE` / `source ~/.zshrc`), then run `blackwall` from any directory. Flags pass through: `blackwall --no-open --port 5000`.

## Development

`pnpm dev` runs the server under `tsx watch` plus the Vite dev server with hot reload. On Windows, `./start.ps1` does the same and opens the browser once Vite is up.

```sh
pnpm test           # Vitest, against sources (no build needed)
pnpm typecheck
pnpm lint
pnpm format:check
```

See [`AGENTS.md`](AGENTS.md) for the layout, conventions and design rules.
