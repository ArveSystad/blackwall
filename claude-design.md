# Prompt for Claude Design

Copy everything below the line into Claude Design.

---

Design the UI for **blackwall**, a local developer tool that runs in the browser (localhost only, single user). It orchestrates AI coding agents (Claude Code and GitHub Copilot CLI) that plan, implement and **review each other's work**. The name comes from the Blackwall in Cyberpunk 2077, the barrier that keeps rogue AIs contained. Here the user is the wall: agents work freely inside their worktrees, but nothing leaves the machine without the user's say-so. The UI should feel like a control room at that boundary. Tasks come from Jira tickets, GitHub pull requests or free-text prompts, and agents work in git worktrees on the user's machine.

## Who uses it

A senior developer. They keep it open next to their IDE, glance at it to see what needs them, answer agents' questions, approve plans, triage review findings and confirm before anything is pushed. They value density, speed and keyboard navigation over hand-holding.

## Visual direction

- **Dense dev-tool feel**, in the family of Linear, GitHub and VS Code. Compact rows, small but readable type, keyboard-first, very little decorative chrome.
- **Monospace** for agent output, code, diffs, file paths, branch names and commit hashes. A clean sans-serif for everything else.
- **Two themes**, following the OS setting:
  - **Dark (primary design target):** a cyberpunk mood. A deep blue-purple background (layered surfaces from near-black indigo up to dusky violet), with **bright neon accents that glow**: cyan, magenta/hot pink, electric violet, used with soft outer glows on focus rings, active states, running indicators and key calls to action. Body text is **muted off-white / soft gray**, not pure white, so long agent transcripts are easy on the eyes. Glow is an accent, not wallpaper; reading surfaces stay calm.
  - **Light:** clean and fairly generic. Neutral grays, one accent color, the same layout and semantics.
- **Diffs use the standard conventions**: green for additions, red for deletions, in both themes. They stay legible on the dark purple background, so no neon on diffs.
- **Semantic colors** must stay consistent and distinct from the neon accents:
  - Severity: **Critical** (red), **High** (orange), **Medium** (yellow/amber), **Low** (slate / gray-blue).
  - Task status: running (animated, accent glow), needs you (attention-grabbing, the most important state in the app), interrupted, failed, done.

## Layout

### Main screen: two panes

**Left pane, task inbox (about 320–380px):**
- A list of task cards, sorted with **needs you** at the top, then running, then the rest.
- Each card shows a compact set of metadata:
  - Origin icon + key (Jira `ABC-123`, PR `owner/repo#42`, or free text).
  - Title.
  - Repo name.
  - A small stage progress indicator: Inform → Plan review → Implement → Checks → Code review → Finish.
  - Status badge.
  - Agents involved (tiny CLI icons for Claude / Copilot).
  - Relative time.
- A "New task" button and a filter/search at the top.
- The browser tab title shows the needs-you count, e.g. `(2) blackwall`.

**Right pane, task main view.** The workspace for the selected task:
- **Header:** title, origin link, repo, branch name (mono), mode (Work on PR / Review PR / Jira / Free text), and a stage stepper showing where the task is in the pipeline, including review loop round ("Review round 2/3").
- **Body:** sections or tabs for the stage content:
  - **Context:** the Jira ticket or PR summary the agents were given, plus the user's free text.
  - **Plan:** a rendered markdown plan with an **Approve plan** action and a way to request changes.
  - **Grill:** a question-and-answer thread. The reviewer agents' questions about the plan appear here. Some are answered by the planner agent; others are flagged **needs your decision** and have an inline answer box. It should read as a structured interview, not a chat app.
  - **Agent output:** live, streaming per-step transcripts. Show messages, collapsible tool calls (e.g. "Edit `src/foo.ts`", "Ran `pnpm test`"), and per-agent identity (name + CLI icon + model). Steps grouped by stage and round.
  - **Findings:** a table/list of review findings. Each row has severity chip, tags (e.g. `security`, `ux`, `code-quality`, `spelling`), reviewer agent, file:line, title, and expandable explanation + suggested fix. Each row also has **Force fix** and **Force ignore** actions. Filter by severity/tag/reviewer. Make it obvious which findings gate the loop (Critical + High).
  - **Diff:** a side-by-side or unified diff of the worktree changes, with the option to view per review round.
  - **Checks:** build/test command results (pass/fail, collapsible logs).
- **Finish panel:** the summary plus a confirmation list of outward actions, each with a checkbox, pre-ticked, showing exactly what will be sent (e.g. "Push `feature/abc-123-login-fix` to github.com/acme/web", "Open PR", "Comment on ABC-123"). A single confirm button.
- **Input bar:** a free-text box to give the running task extra instructions or context.

### New task form (modal or full pane)

- Origin picker: Jira issue (key or URL) / GitHub PR URL (with mode Work on PR vs Review PR) / Free text.
- Repo picker from the registry.
- Free-text context.
- Agent per role (planner, plan reviewers, implementer, code reviewers, summarizer), pre-filled from defaults. Reviewers are a multi-select from the agent library.
- Triage mode toggle: "Run and let me intervene" (default) vs "Pause each review round".

### Settings

Sections:
- **Connections:** GitHub.com / GitHub Enterprise hosts / Jira Cloud. Each shows name, URL and token status ("configured ✓" / "missing"). Tokens are never displayed.
- **Repositories:** a registry list with path, remote and check commands. "Add repo" and "Scan folder" actions. Stale/deleted repos show a warning state.
- **Agent library:** cards or rows for agents (e.g. "Security reviewer", "UX reviewer", "Implementer"), each with CLI, model, prompt editor, eligible stages and permission profile. Add, edit, duplicate, delete.
- **Tags:** an editable list of finding tags.
- **Defaults:** default agent per role, concurrency cap per repo.

### Missing token modal

Appears when an action needs a connection or token that isn't configured. It explains what's needed (e.g. "Personal access token for jbf.ghe.com with `repo` scope"), has a password input, and a save button.

## States to design

- Empty inbox (first run): guide the user to add a connection and a repo.
- A task that **needs you** (plan approval, grill question, escalation after 3 review rounds, finish confirmation). This must stand out in the list and in the main view.
- A task actively running, with streaming output.
- Interrupted task with a **Resume** button.
- Failed task with the error.
- Review loop in progress, with findings from several reviewers.

## Deliverables

- Dark and light versions of: the main two-pane screen (with a task in code review showing findings), the grill/plan approval view, the finish confirmation, new task form, settings (agent library), missing token modal.
- A small design-token sheet: color tokens for both themes (surfaces, text, accents/glows, severity, status, diff), type scale, spacing, radii and glow/shadow recipes. It should map cleanly onto Tailwind CSS + shadcn/ui (Radix), since that's the implementation stack.
