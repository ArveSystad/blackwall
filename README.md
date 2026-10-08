# blackwall

A local, browser-based harness for coding agents. Claude Code and GitHub Copilot CLI plan, implement and review each other's work on your own repos, driven by Jira Cloud tickets, GitHub/GHE pull requests or free-text prompts.

> Status: planning. See [`grill-result.md`](grill-result.md) for the design, [`claude-design.md`](claude-design.md) for the UI design brief and [`tasks/backlog/`](tasks/backlog/) for the work items. The commands below describe the intended launch flow (task-023).

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
pnpm start          # builds if needed, starts on 127.0.0.1 and opens your browser
```

`pnpm start -- --no-open` skips opening the browser. `pnpm start -- --port 4711` picks a port.

The server binds to `127.0.0.1` only and prints a URL containing a per-launch token. Data lives in `~/.blackwall/`. Personal access tokens are stored in your OS keychain, never in the database.

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

Restart the shell (or `. $PROFILE` / `source ~/.zshrc`), then run `blackwall`.
