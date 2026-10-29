# blackwall: design and feature brief

This file is self-contained. It is written for Claude Design, so a promo or explainer video of
blackwall can be made without reading the code. Every colour, duration, size and quoted UI string
below is copied from the code as of `main` at `295dafe`. Where a value later disagrees with
`apps/web/src/styles.css` or the components under `apps/web/src`, the code wins. The `.dc.html`
mockups in this folder are older and differ in places (see [README.md](README.md) § Drift).

## 1. What blackwall is

blackwall is a local, single-user control room for coding agents. It runs on `127.0.0.1` in the
browser, or in its own desktop shell (Electron, with a title bar that follows the theme). It
drives three agent CLIs as headless subprocesses against the user's own git repos:

| CLI | Tile | Accent token (dark / light) |
|---|---|---|
| Claude Code | `CC` | `--claude` `#f0956b` / `#b4522b` |
| GitHub Copilot CLI | `CP` | `--copilot` `#8fb3ff` / `#2f5fc4` |
| OpenCode | `OC` | `--opencode` `#c3a6ff` / `#6b46c1` |

Agents plan, grill, implement and review each other's work. The human approves the plan, answers
questions, triages findings and confirms every outbound action. The first-run headline says it:
**"Agents work inside. Nothing crosses the wall without you."**

### The pipeline

The UI shows six stages (`UI_STAGES`). Aggregate folds into Code review and Summarize folds into
Finish.

| # | Stage | What happens | Human gate (banner title) |
|---|---|---|---|
| 1 | Inform | The planner reads the origin and writes a plan. | |
| 2 | Plan review | Plan reviewers grill the plan. The planner answers what the repo can settle. | "N questions need your decision", then "Plan ready for approval" |
| 3 | Implement | The implementer edits and commits in its own worktree. | |
| 4 | Checks | The repo's check commands run after each implement round. | |
| 5 | Code review | A panel of reviewers files findings. Critical and High gate the loop; at most 3 fix rounds. | "First review paused for your triage" / "Review loop stopped after fix round N" |
| 6 | Finish | The summarizer writes the summary, then the user confirms delivery. | "Ready to finish", then the pill reads "Finishing" while it delivers |

Gate reasons shown on cards and hover cards (`GATE_REASONS`): "Questions need your decision",
"Plan ready for approval", "Findings ready for triage", "Review loop hit the round cap", "Ready to
finish". A done task whose CI failed shows "CI failed" and sits under Needs you.

**Review PR mode** skips plan and implement: Inform → review panel → triage → inline PR comments.
The user picks the findings to post ("Review ready to post").

### Origins and branches

| Origin (new-task label, key) | Branch |
|---|---|
| Jira issue (1) | `feature/<key>-<slug>`, or `fix/…` for a Bug |
| GitHub PR (2), "Work on PR" or "Review PR" | the PR head branch |
| Blackwall (3), free text | `agent/<task-id>`, rebased and fast-forwarded into the local default branch at finish |
| GitHub issue (4) | `feature/<number>-<slug>`, or `fix/…` with a `bug` label |

### Backlog, runner and follow-ups

- Each repo has a backlog. Its runner promotes the next item to a task when the repo is idle and
  quotas allow. The top bar shows "N waiting" per repo.
- Quick add: "Quick add: describe the work, Enter adds it to the queue". "Start working" promotes an
  item by hand and starts its task without leaving the backlog.
- Summarize may propose up to 5 follow-up tasks. On confirm they land in the backlog.
- Stacked PRs: adding a PR in a stack also queues its sibling PRs as Review PR items, labelled
  "stack #41 · 2/3".
- When the local default branch is ahead of origin, the Backlog header offers "Push N commits to
  main". This is the only way the default branch is ever pushed, and only after a confirm.

### Trust levels

Each repo has an agent trust level (`TrustBadge`): **Locked** (default sandbox, no badge),
**Trusted** (neutral chip; also loads the repo's own skills and agents), **Unrestricted** (red chip
with a warn icon). A task that runs code the user did not write is forced Locked: "Locked (Review
PR)", "Locked until the branch is checked", "Locked (others' commits on branch)". The chat always
runs Locked. The `?` help dialog beside "Agent trust" in repo settings is the detailed reference;
its copy lives in `apps/web/src/trust.ts`.

### Reference repos, CI and comments

- Reference repos: planners, reviewers and the chat can read other registered repos, and never
  write to them.
- CI watching: after a push the task shows a CI badge: "CI running", "CI passed", "N checks
  failed", "CI timed out", "No CI", "CI unavailable".
- **Fix CI** runs a fix round with the failing logs and stops at Finish again.
- **Fetch comments and fix** turns new PR review comments into findings and runs a fix round.

## 2. Visual identity

A dark, neon HUD: deep indigo-black surfaces, chamfered corners, cyan for the machine and magenta
for the human. Dark is always the default. Light is opt-in (top bar toggle or `T`) and never
follows the OS.

### Colour tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-0` | `#0a0918` | `#f3f3f6` | app canvas |
| `--bg-1` | `#100e22` | `#ffffff` | panes, top bar |
| `--bg-2` | `#161330` | `#fafafc` | cards, inputs |
| `--bg-3` | `#1e1a3f` | `#eff0f4` | hover, selected row |
| `--bg-4` | `#2a2352` | `#ffffff` | popover |
| `--bg-modal` | `#141130` | `#ffffff` | dialogs |
| `--border` | `#262046` | `#e3e3ea` | hairlines |
| `--border-strong` | `#3a3169` | `#cdcdd8` | frame lines |
| `--fg` | `#c4c1d9` | `#2b2b35` | body |
| `--fg-strong` | `#ebe8f7` | `#111118` | titles |
| `--fg-muted` | `#9590b4` | `#5d5d6c` | meta |
| `--fg-faint` | `#6f6a90` | `#9a9aa8` | disabled |
| `--primary` | `#a77bff` | `#5a45e0` | violet: primary action, selection |
| `--cyan` | `#2ee6ff` | `#1d6fe0` | machine working, focus |
| `--magenta` | `#ff3dcf` | `#c4167c` | human needed |
| `--needs-fg` | `#1a0614` | `#ffffff` | text on magenta |
| `--st-running` | `#2ee6ff` | `#1d6fe0` | status |
| `--st-needs` | `#ff3dcf` | `#c4167c` | status |
| `--st-interrupted` | `#a8a2cc` | `#6b6b7b` | status |
| `--st-failed` | `#ff5c78` | `#cf2236` | status |
| `--st-done` | `#5cd69a` | `#1a7f37` | status |
| `--st-assigned` | `#ffe14d` | `#a37a00` | new-work boom only |
| `--sev-critical` | `#ff4d5e` | `#cf2236` | severity |
| `--sev-high` | `#ff8b3d` | `#c2530a` | severity |
| `--sev-medium` | `#f2c14e` | `#9a6d00` | severity |
| `--sev-low` | `#8e9dbc` | `#5a6880` | severity |
| `--diff-add-fg` / `-bg` | `#8fe0a8` / `rgba(46,160,67,0.15)` | `#1a7f37` / `#e9fbee` | diff added |
| `--diff-del-fg` / `-bg` | `#ffa39b` / `rgba(248,81,73,0.14)` | `#b3202c` / `#fff0ef` | diff removed |
| `--needs-wash` | `rgba(255,61,207,0.07)` | `#fdf0f7` | needs-you card wash |
| `--running-wash` | `rgba(46,230,255,0.06)` | `#f0f6ff` | running wash |
| `--code-bg` | `#0c0b1c` | `#f6f7f9` | code blocks |
| `--overlay` | `rgba(5,4,16,0.74)` | `rgba(20,20,30,0.38)` | dialog scrim |
| `--grid-line` | primary 44% (`color-mix`) | border-strong 80% | backdrop grid |
| `--grid-glow` | cyan 24% (`color-mix`) | transparent | backdrop glow |

### Colour meaning (fixed)

- **Cyan = the machine.** Running agents, the focus frame, the stream sweep, the laser.
- **Magenta = the human.** Needs-you rail, wash, banner, the CTA that resolves it. Nothing else is
  magenta.
- **Violet = action.** The primary button and selection. At most one violet and one magenta CTA
  per view.
- Severity colours never mean status, and status colours never mean severity. Diffs are plain
  green and red: no glow on diffs, transcripts, long text or table rows.

### Glow

Glow marks state only, and only in dark. Dark glows: `--glow-cyan` (1px ring + 14px glow),
`--glow-magenta` (1px + 18px), `--glow-violet` (1px + 16px), plus text glows on cyan, magenta and
done green. Light swaps each for a 1px border and a 3px tinted ring (`0 0 0 3px` at 14–18%), and
text glows become `none`. Chamfered surfaces glow through `drop-shadow` (`--drop-glow-*`) because
`clip-path` drops `box-shadow`. The focus ring is cyan in dark (`--ring: var(--glow-cyan)`) and
violet in light (`--ring: var(--glow-violet)`).

### Typography

| Role | Font | Size / line height |
|---|---|---|
| title | Geist, semibold | 18 / 24 |
| heading | Geist, semibold | 15 / 20 |
| body | Geist | 13 / 20 |
| meta | Geist | 12 / 18 |
| label | Geist, 600, uppercase, 0.06em | 11 / 16 |
| code | Geist Mono, −0.01em | 12 / 19 |
| display | Chakra Petch 600 | wordmark 21px; first-run hero 28/34; empty states 22/28 |

Geist Mono is for code, paths, branches, hashes, issue/PR keys and keyboard hints.

### Wordmark

- A cyan `WallIcon` (size-6, 24px), a 12px gap, then **blackwall** in Chakra Petch 600, 21px, 0.14em
  tracking, lowercase.
- "black" is `--fg-strong`. "wall" is the wordmark accent: cyan with a 10px cyan text glow in
  dark, primary violet with no glow in light.
- It decrypts once per app load (220ms glyph scramble), then flickers like a failing neon tube
  every 30–100s for 700ms (`steps(1,end)`, opacity only).

### Shape: chamfers, not radii

- Every radius token is `0`. Corners are chamfered, never rounded; only true circles (dots, step
  nodes) are round.
- `.bw-chamfer`: the top-left and bottom-right corners are cut by **8px** (panels, cards, buttons,
  dialogs, fields). The 1px frame line is an `::after` in `--border-strong`.
- `.bw-chamfer-pill`: a **5px** cut for 20px pills, chips and tags.
- Checkboxes and radios: 15px squares with a **3px** cut, filled `--primary` when checked.
- `.bw-chamfer-seg`: in a segmented group, only the group's outer ends are cut.
- Focus is the frame line itself: **2px cyan**. Primary and needs buttons focus in their own
  foreground colour.
- `.bw-brackets`: four L-shaped corner brackets (10px arms, 1px) around the task header. They turn
  cyan while anything inside has focus.

### Core components

- **StatusBadge**: a 20px chamfered pill (5px cut), 11px semibold label: Queued, Running, Needs you,
  Interrupted, Failed, Done ("Finishing" while delivering). Needs you blinks a magenta dot and has
  a magenta halo; Running pulses its dot.
- **SeverityChip**: Critical, High, Medium, Low. Critical and High carry a magenta lock icon,
  "Gates the review loop".
- **StagePips**: six 12×4px bars on each card. Past bars are faint, the current one is in the
  status colour, future ones are `--border-strong`.
- **StageStepper**: numbered nodes with "✓" when done, joined by connectors. The current node shows
  "fix round N/MAX" beside it.
- **AgentTile**: a 16px chamfered tile in mono 9px: CC, CP, OC.
- **Icons**: 33 inline line-SVGs in `components/icons.tsx` (WallIcon for the brand; Jira, PR,
  issue and text icons for origins; Lock, Warn, Failed, Paused, Spinner for state; and so on).

### Copy voice

Terse HUD status lines: a short state, then a plain consequence, as two clipped sentences. No
exclamation marks, no "Oops", no emoji. Say what happens and what the user can do. Examples, all
real:

- "Nothing on deck. Awaiting orders."
- "Backlog clear. Nothing queued."
- "Queue empty. Nothing waiting."
- "Clean sweep. No findings."
- "Wall secure. Nothing leaves. Confirming marks it done."
- "Channel open. Waiting for first output…"
- "No channel. Pick a repo to chat about it."
- "Reviewers on the plan. Questions land here."
- "Log empty. No tasks resolved yet"
- "Kept local. Nothing left this machine."

## 3. Screen by screen

The shell is a 44px top bar over a 352px inbox column on the left and the main pane on the right,
with the chat panel optionally on the far right.

### Top bar

- **What you see** (left to right): the wordmark in a 352px column; the `Repo` label and a repo
  select ("No repo", or each repo with "N waiting"); "View backlog"; a status line such as "2 tasks
  running · auto-start enabled"; the repo path in mono, or "Pick a repo to work in". On the right:
  a muted "Quota · 14:05" chip while a CLI's quota is paused, then icon buttons for Search, Chat,
  Theme, Stats and Settings.
- **What you can do**: switch repo; open the backlog; search (Ctrl+K); toggle chat ("Open chat
  (C)"); switch theme ("Switch to light theme (T)"); open Stats and Settings. Ctrl reads ⌘ on macOS.

### Inbox and TaskCard

- **What you see**: groups "Needs you" (magenta), "Running" (cyan) and "Recent" (muted), each with
  a count. Above them sit a "Filter tasks" field (`/`) and a "New task" button (`N`), and the live
  line reads "Live · 2 active agents". The footer has "Archive N done" (title "Archive all done
  tasks"). Loading: "Pulling the task list…". Empty: "The wall is quiet".
- **TaskCard**:
  - First line: the origin icon and mono key (e.g. `ABC-123`, `owner/repo#42`, or `blackwall`),
    then a relative time ("now", "5m", "3h", "yday", "4d").
  - Then a two-line title and the gate reason with a warn icon in magenta.
  - Bottom row: the repo, StagePips, agent tiles, the trust chip, a compact CI badge and the
    StatusBadge.
  - Needs-you cards add a 3px magenta rail with glow and a magenta wash.
- **What you can do**: open a task, filter, start a new task, archive all done, delete a card on
  hover.

### Task view

- **Header** (framed by `.bw-brackets`): the origin kind ("Jira", "Pull request", "GitHub issue",
  "Blackwall"), the title (which decrypts on load), the repo breadcrumb, the branch, "Started 3m
  ago", "2 agents, 3 reviewers", a usage chip ("N tokens · <cost>") and the trust chip.
  - Buttons: "Stop" (`S`), "Archive", and Delete.
  - Under a running task's header a 2px cyan stream sweeps left to right.
  - Then the **StageStepper**.
- **NeedsBanner**: a chamfered magenta-washed banner with a title and detail, and the action that
  resolves it as a magenta button: "Answer questions", "Approve plan" (`A`) beside "Request
  changes" (`R`), "Choose findings to post", "Start fix round 2", "Accept as is", "Review outbound
  actions", or "Fix CI".
- **Interrupted or failed**: a card reading "The task failed", "Stopped" or "Stopped mid-step",
  with "Retry" or "Resume" (`R`).
- **Tabs**: Context, Plan, Grill, Agent output, Findings, Diff, Artifacts, Checks, Finish. Counts
  show in mono (open questions in magenta, "+12 −3" on Diff, "3/4" on Checks). A live dot sits on
  Agent output.

The tabs:

- **Context**: "Context", "Workspace" (Repository, Branch, Worktree), "Agents" with each role's
  agent and model ("Auto" when unset).
- **Plan**: the plan in markdown. "Approve plan" (`A`) and "Request changes" (`R`). The empty state
  is "Standing by. The planner writes the plan in the Inform stage."
- **Grill**: see below.
- **Agent output**:
  - A "Steps" list ("Implement · Claude · r1", each with a status) and a "Follow output" checkbox.
  - A mono transcript of messages and **ToolCall** rows (verb, mono target, result, "running…" in
    cyan).
  - Sub-agent calls fold in as "Sub-agent".
- **Findings**:
  - Severity filter chips, "Gating only", and the legend "Critical + High gate the loop".
  - A table with the columns Severity, Finding, Reviewer, Location and Triage.
  - A **FindingRow** expands to "Why" and "Suggested fix", with "Force fix" (`F`), "Force
    ignore" (`I`) and "Delete" (`D`).
- **Diff**:
  - A "Review round" segmented control ("Implementation", "Fix round N").
  - Files in plain green and red.
  - "Step through" walks hunk by hunk ("Hunk 3 of 9 · file 2 of 4", Previous ← / Next →). The user
    can comment on a hunk and "Send 2 comments and run a fix round".
- **Artifacts**: files (screenshots, notes, logs, archives…) the implementer saved to
  `.blackwall/artifacts/`, as a grid of cards. Images preview, text and code show their top as
  plain text (Markdown rendered), and other files show an extension badge and download. The empty
  state is "Nothing captured yet. …".
- **Checks**: one block per round ("Round 1", "3/4 passed"), with rows that are "Passed",
  "Timed out" or "Exit 1".
- **Finish**:
  - The summary, with fix rounds, findings fixed/ignored/open, and "Checks x/y passed".
  - The outbound panel, "Outbound · crosses the wall": "Nothing leaves this machine until you
    confirm. Untick anything you want to keep local."
  - Each **OutboundAction** is a checkbox showing exactly what is sent: "Push branch", "Open pull
    request: <title>", "Comment on ABC-123", "Merge into local main", "Create 2 follow-up tasks".
  - The confirm button counts them: "Confirm and send 3 actions" (`⌘↵`). The secondary actions
    are "One more fix round" and "Keep local, mark done".
  - While delivering, the button reads "Finishing…" and the pill reads "Finishing".
  - Afterwards the panel reads "Outbound · crossed the wall" and "Delivered. The pull request is
    linked below.". It then shows the "Open pull request" link, the CI block with its badge, "Fix
    CI" if CI fails, and "Fetch comments and fix".
  - If a step ran Unrestricted, a red alert warns before confirming.

There is **no input bar** in the task view. You steer a task from the chat (see §4).

### The Grill gate

- **What you see**:
  - A "Questions" header with counts: "N answered by planner", "N answered by you" and "N need
    your decision" (magenta).
  - Numbered question cards ("Question 1"), each with the asker, a status ("Needs your decision"
    pill, "Answered by planner", "Answered by you", "Waiting on planner"), and the answer labelled "Planner" or "You".
  - The plan in a side column.
- **What you can do**: type into "Your answer" ("Decide for the planner. It revises the plan with
  your answer.") and press "Answer" (`⌘↵`). The answer goes back to the planner, who revises the
  plan. Then, on the Plan tab, "Approve plan" unlocks: "Approve unlocks once the open question is
  answered and the reviewers have seen the revised plan."

### New task modal

- **What you see**: the title "New task". An "Origin" segmented control with Jira issue, GitHub PR,
  Blackwall and GitHub issue (keys 1–4). For PRs there is a "Mode" control ("Work on PR" / "Review
  PR").
  - The origin field changes with the origin: "ABC-123 or https://acme.atlassian.net/browse/ABC-123",
    a PR or issue URL, or "What should the agents do? The first line becomes the title.".
  - Then come "Repository", "Title", "Depends on" (a filterable multi-pick dropdown), "Reference
    repos" (a filterable multi-pick dropdown), "Context", "Agents" (per-role chips and selects,
    "Advanced" for a per-agent CLI, "Reset to defaults") and "Triage".
  - The footer hint is "Starts now: this repo's backlog runs.".
- **What you can do**: "Create task" (`⌘↵`), "Cancel", `Esc`.

### Backlog and Archive (`/repos/$repoId/backlog`)

- **What you see**:
  - The header: "Backlog", the repo, "N waiting", and "Push 3 commits to main" when ahead. After a
    push it flashes "Pushed to main" with a green glow.
  - The runner bar ("Runner"): Off, Idle, Waiting, Paused or Halted, with a line such as "Next:
    <title>" or "Queue empty. Nothing to run.", and the checkbox "Run this repo's backlog".
  - The quick-add field.
  - Sections: In progress, Queue, GitHub issues, Other tasks, Archived.
  - Queue rows show chips ("Next up", "Waiting", "Paused", "Blocked by …") and "From <task>" for
    follow-ups.
  - The Archive bar: "N archived", "Show archive (N)", "Archive done (N)", and the field "Search
    archive".
- **What you can do**: "Start working", "Pause"/"Unpause", "Edit", "Archive", "Delete"; J/K to move,
  Alt ↑/↓ to reorder, P to pause; "Start working" for GitHub issue rows (assigns the issue and
  starts its task without leaving the backlog); "Unarchive".

### Review requests (`/reviews`) and Assigned issues (`/issues`)

- Review requests: "Review requests", "N waiting", grouped by host. Each PR row has "Work on task".
  The empty state is "All clear. No reviews requested.".
- Assigned issues: "Assigned issues", "N open". The empty state is "All clear. No issues assigned
  to you.". A row shows "Open task" or "In backlog" once the work exists.

### Active agents (`/active`)

"Active agents", "N running": one row per agent with its stage, task, "round N", model and activity
("Starting…"). The empty state is "All agents idle.".

### Settings (`/settings/$section`)

A left nav with nine sections:

1. **Connections**: GitHub and Jira Cloud hosts, with Test, "Set token", "Forget token" and Remove.
   Tokens show only as "Configured" or "Missing".
2. **Repositories**: drag to reorder, ★ to pin. Per repo: default CLI, origin and branch, the
   backlog cap, "Watch CI after push", "Agent trust" (Locked / Trusted / Unrestricted, with a `?`
   help dialog explaining each level and a confirm "Allow everything"), reference repos and check
   commands.
3. **Agent library**: a model per CLI, eligible stages, prompt, allow/deny overrides.
4. **Tags**: the finding tag list.
5. **Defaults**: the agent per role, and tasks per repo.
6. **Backlog**: "Run backlogs automatically", "Stop when a task needs me", issue refresh.
7. **Notifications**: "Notify me when a task needs you".
8. **Data**: "Export data" and "Import data…" ("Replace all blackwall data?").
9. **System**: data directory, database, worktrees, runtime, Agent CLIs, "Compact database".

### Stats (`/stats`)

- On the grid backdrop: a "Tasks resolved" headline number in done green with glow ("Log empty. No tasks resolved yet").
- Tiles: Jira issue, Work on PR, Review PR, GitHub issue, Blackwall, and "Repositories touched"
  ("of N registered").
- "Resolved per day · last 10 days": 10 bars that grow in once (480ms). Bars with a count are done
  green with glow, empty days are grey, and the labels read "Today", "Thu 8".
- "Usage per day · last 10 days" and "Usage per repo", with tokens and cost.

### Search palette (Ctrl+K)

A 640px dialog near the top with "Search tasks, backlog and repos". There is a scope switch, "All
repos" / "This repo", and results grouped Tasks, Backlog, Repos. Its states are "Searching…",
"Nothing matches “query”" and "Search failed.". The footer reads "↑ ↓ move · ↵ open · Esc close".

### Dialogs

- **ConfirmDialog**: 420px, "Cancel" and a destructive confirm ("Working…" while pending, `↵`).
- **MissingTokenModal**: "Token needed for github.com". It says the token is "Stored on this machine
  only. It is never shown again", with "Save and continue". If the user cancels, the action reports
  "Cancelled: no token saved". Tokens are never displayed.
- Every dialog opens with a 150ms left-to-right **scan-wipe**. Closing reverses it: a 120ms wipe, right to left.

## 4. Chat

- **Panel**: a right-hand panel beside every page, never an overlay. Toggle it with the chat
  button or `C`.
  - Width 250–900px (default 380), remembered per browser. The main pane keeps at least 360px.
  - The left edge is a resize separator: an 8px hit area over a 1px line that turns **2px cyan** on
    hover, drag or focus. ←/→ step 16px.
- **Scope**:
  - The header reads "Chat · <repo>". With no repo selected the panel is empty: "No channel. Pick a
    repo to chat about it."
  - On a task page it switches to that task's own conversation, "Chat · About <task title>", with
    the task's status pill. When the worktree exists, the chat reads it.
- **What it does**: answers about the code, tasks and backlog. Empty state: "Channel open. Ask
  about this repo. Proposed actions wait for you to apply them." While busy, a cyan line reads
  "Thinking…" (or the current activity).
- **Action cards**: the reply can propose actions, each a card with "Apply" → "Applying…" → "Done":
  - "New backlog task" (`create-task`)
  - "Request changes · planner" and similar (`message-task`, magenta when the task waits)
  - "Answer question"
  - "Stop task" (destructive)
  - "Resume task" / "Resume with guidance"
- **Turn into task**: any assistant reply can become a backlog item card ("Turn into task" →
  "Adding…").
- **Direct send** (task pages): `⌘⇧↵` sends the draft straight to the task's gate (e.g. "Request
  changes · planner") or as "Resume with this", without asking the chat agent.
- **/clear**: starts over. While an answer is running it asks first: "Stop and clear the chat?",
  "The answer in progress is stopped and the conversation is dropped.", "Stop and clear".
- **Motion**: the panel's width slides over 180ms (ease-out to open, ease-in to close), and its
  content fades and shifts 12px. New messages fade in over 150ms; history never does.

## 5. The grid backdrop screen

The home pane, when no task is open, is the signature visual: a neon perspective floor with the
active agents as glowing dots on it.

### Layers (back to front)

1. **Glow**: a cyan radial ellipse centred on the horizon.
2. **Sky**: a flat 48px grid above the horizon at 45% opacity.
3. **Horizon**: a 1px line at **58%** of the height with an 18px glow.
4. **Floor**: a 48px grid tilted `rotateX(62deg)` in 320px perspective, drifting toward the viewer
   (`bw-grid-drift`, 28s linear loop).
5. **Scan**: a 2px glowing line sweeping top to bottom every 12s (dark only).
6. **Spotlight**: a 220px circle under the pointer. In dark it brightens the lines (brightness 2.2);
   in light it darkens them (0.55). Touch is ignored.
7. **Film**: grain over the whole pane (180px noise tile, 14% opacity, jumping every 0.9s), plus two
   flicker veils that dim toward `--bg-0` on 23s and 37s loops. The loops are coprime, so the dips
   feel random.

Behind centred content (first run, empty states, Stats) the lines fade to 18% under a ~520px
centre column. When agents are shown the grid runs **full width**. The fade change eases over 600ms
(`--grid-fade`).

### Empty and first-run states

- **First run**: the eyebrow "First run", then the hero "Agents work inside. Nothing crosses the
  wall without you." in Chakra Petch 28px, then three chamfered steps: "Add a connection",
  "Register a repository", "Start a task". The current step glows cyan; later steps sit at 60%.
- **Nothing active**: "Nothing on deck. Awaiting orders." with "Create task" (`N`), plus "View
  backlog", or "Backlog clear. Nothing queued.". On error it shows "Could not load tasks" with
  "Retry".
- **Bottom pills** (after first run): "N pull requests need your review" and "N issues assigned to you",
  36px chamfered pills. With a count they are magenta, with a blinking dot; with none they are muted.

### Agent dots

Dots sit on the floor between 64% and 90% of the height, placed by a stable hash. Hit targets are
24px and dot centres are at least 28px apart.

| State | Dot | Motion |
|---|---|---|
| Running | 8px cyan with cyan glow | `pulse-running` 1.6s, plus a boom |
| Sub-agent | 6px cyan | pulse |
| Needs you | 10px magenta, drawn on top | `pulse-needs` 1.4s, plus a magenta boom |
| Queued | 8px faint at 60% | still |
| Done | 8px green with done glow | `pulse-done` 2.4s, calmer |
| Interrupted | 8px grey | still |
| Failed | 8px red | still |

- **RunningHeadline**: centred "3 TASKS RUNNING" ("1 task running"). Geist semibold, 28–40px,
  0.18em tracking, uppercase, cyan with text glow. The number decrypts when it changes. A brighter
  copy glows in a 120px circle around the pointer.
- **Hover card** (288px chamfered popover above the dot):
  - Running: the task title, the stage in cyan, the agent and its activity or "Starting…".
  - Needs you: the stage in magenta and the gate reason, e.g. "Plan ready for approval".
  - Sub-agent: "Sub-agent", then its description and "via Claude".
  - Queued: "Queued".
  - Done: "Done · Ctrl+click to archive".
  - Failed or stopped: "Failed · Implement", "Stopped", or "Stopped mid-step", the error, and
    "Ctrl+click to retry" / "Ctrl+click to resume", which becomes "Retrying…" / "Resuming…".
  - Ctrl reads ⌘ on macOS.
- **Laser**: when a task changes stage, a 2px × 40px cyan beam fires straight up from its dot.
- **Boom**: every running or needs-you dot sends a 72px ripple ring, and each task's first dot also
  sends a wide 26rem bloom, looping at twice the pulse period.
- **Revive**: Ctrl+click on a failed or stopped dot plays one cyan boom, and a faint cyan ring
  holds until it runs. If the request fails, the boom is red.
- **Supernova**: as a task turns done, its dot bursts green: a 16px core flash, a 240px ring, and
  eight sparks along the grid lines (four long, four shorter diagonals). Several bursts stagger by
  80ms.
- **Launch**: Ctrl+click on a done dot archives it. The dot flies to the centre of the horizon and
  shrinks to nothing, speeding up into the distance. "Archive N done" in the inbox launches every
  done dot at once.
- **Assigned boom**: when a bottom pill's count rises from zero, a big yellow boom (44rem bloom,
  160px ring) and a yellow flash over the pill play once, then the pill settles to magenta.

## 6. Motion catalogue

Motion marks state. The three decorative exceptions are the grid backdrop (home and Stats), the
Stats bar grow-in, and the wordmark flicker. Under `prefers-reduced-motion` a base rule removes
every animation and transition. One-shots that would freeze visible are hidden (`display: none`),
and JS skips the decrypt, the wordmark flicker and the chat open/close.

| Effect | Class / token | Trigger | Duration / easing | Light theme | Reduced motion |
|---|---|---|---|---|---|
| Running pulse | `animate-pulse-running` | running dot, badge | 1.6s ease-in-out, loop, 4px ring | no glow | still |
| Needs pulse | `animate-pulse-needs` | needs-you dot | 1.4s ease-in-out, loop, 7px ring | no glow | still |
| Done pulse | `animate-pulse-done` | done dot | 2.4s ease-in-out, loop | no glow | still |
| Needs blink | `animate-blink-needs` | needs dot in pills and badges | 1.2s `steps(2, jump-none)`, to 35% | same | still |
| Stream sweep | `.bw-stream` | running task header | 1.4s linear loop, 120px band | no glow | static track |
| Stage fill | `.bw-stage-fill` | stage advance | 600ms ease-out, full by ~40% | same | hidden |
| Lock-on | `.bw-lock-on` | stage advance | 600ms ease-out after 200ms, scale to 2.2 (800ms total) | no glow | hidden |
| Laser | `.bw-laser` | dot changes stage | 900ms ease-out, rises 55vh | no glow | hidden |
| Boom | `.bw-boom` | running / needs dot | 3.2s running, 2.8s needs, ease-out loop; 26rem bloom + 72px ring | ring only | hidden |
| Revive | `.bw-revive` | Ctrl+click retry/resume | 1.2s once; red on failure | ring only | hidden |
| Supernova | `.bw-supernova` | task turns done | core 150ms, ring 1.2s, sparks 700ms, 80ms stagger | no glow | static core for 300ms |
| Launch | `.bw-launch` | archive a done dot | 900ms `cubic-bezier(0.5, 0, 0.9, 0.4)` | no glow | hidden |
| Assigned boom | `.bw-assigned` | pill count rises from 0 | 2.4s once, yellow; 44rem bloom, 160px ring | ring only, no flash glow | hidden |
| Grid drift | `.bw-grid-plane` | always | 28s linear loop | same | still |
| Grid scan | `.bw-grid-scan` | always | 12s ease-in-out loop | hidden | still |
| Grid fade | `--grid-fade` | agents view on/off | 600ms ease-out | same | instant |
| Spotlight | `.bw-grid-spot` | pointer over pane | 300ms fade in | darkens lines | instant |
| Film grain | `.bw-film-grain` | always | 0.9s `steps(1, end)` loop | dark speckles, 11% | static |
| Film flicker | `.bw-film-flicker-a/-b` | always | 23s and 37s `steps(1, end)` loops | shallower (veil 0.2) | hidden |
| Wordmark flicker | `.bw-wordmark-flicker` | every 30–100s | 700ms `steps(1, end)` | same | never scheduled |
| Decrypt | `.bw-decrypt` | wordmark at load, headline number, task title | 220ms (`DECRYPT_MS`, rAF) | same | skipped |
| Headline hover | `.bw-running-hot` | pointer near headline | 300ms opacity | darkens, no glow | instant |
| Chat panel | `.bw-chat` | open / close | 180ms width, ease-out / ease-in; content 12px slide | same | instant |
| Chat message | `animate-fade-in` | message appended | 150ms ease-out | same | instant |
| Dialog open | `animate-scan-wipe` | any dialog | 150ms ease-out, left to right | same | instant |
| Dialog close | `animate-scan-unwipe` | any dialog closing | 120ms ease-in, right to left | same | instant |
| Stats bars | `animate-bar-grow` | Stats mount | 480ms `cubic-bezier(0.2, 0.8, 0.2, 1)` | ring instead of glow | instant |
| Pushed note | `animate-pushed-glow` | Backlog push done | 1.6s ease-out glow fade | no glow | static |

## 7. Storyboard

A suggested 60–90 second explainer, in nine scenes. Every line of copy is real UI text.

1. **Cold open.**
   - Shot: a black screen, then the grid floor fades up and drifts toward the camera while the scan
     line sweeps.
   - On screen: the top bar; the wordmark **blackwall** decrypts, then "wall" glows cyan. The pane
     reads "Nothing on deck. Awaiting orders."
   - Motion: grid drift 28s, scan 12s, film grain, a 220ms decrypt.
2. **Give an order.**
   - Shot: press `N`; the "New task" modal scan-wipes open.
   - On screen: Origin "Jira issue", "ABC-123", Repository, the Agents chips, then "Create task".
     The new inbox card shows its agent tiles (CC / CP / OC).
   - Motion: the 150ms scan-wipe. When the modal closes, a cyan dot appears on the floor and the
     headline decrypts "1 TASK RUNNING".
3. **The agents have questions.**
   - Shot: the dot turns magenta and grows, and a magenta boom ripples out. Cut to the task:
     NeedsBanner "2 questions need your decision".
   - On screen: the Grill tab, "Question 1", "Needs your decision". The user types into "Your
     answer" and presses "Answer".
   - Motion: needs pulse 1.4s, the needs blink, the magenta rail on the inbox card.
4. **Approve the plan.**
   - Shot: the banner turns to "Plan ready for approval", and the user presses `A` ("Approve
     plan").
   - On screen: the stepper advances to Implement and the cyan stream sweeps under the header.
   - Motion: stage fill 600ms, lock-on ring 200ms + 600ms, and the laser fires from the dot.
5. **Agents in parallel.**
   - Shot: pull back to the grid, where several cyan dots pulse with blooms and small sub-agent dots
     sit beside them.
   - On screen: "3 TASKS RUNNING". Hover a dot to show the card: "Implement", "Claude", the current
     activity, then "Sub-agent", "via Claude".
   - Motion: the boom loop at 3.2s, and the spotlight following the pointer.
6. **Checks and code review.**
   - Shot: the Checks tab "3/3 passed", then Findings.
   - On screen: Critical and High rows with the lock icon, "Critical + High gate the loop". A row
     expands to "Why" / "Suggested fix" with "Force fix" `F`. Then the Diff: "Step through", "Hunk 2
     of 5 · file 1 of 3".
   - Motion: minimal. Text and diffs never glow.
7. **Talk to the wall.**
   - Shot: press `C`; the chat slides in from the right.
   - On screen: "Chat · About <task>". The reply proposes a card, "New backlog task", and the user
     clicks "Apply" → "Done". Then "Turn into task" on another reply.
   - Motion: the 180ms width slide, and messages fading in over 150ms.
8. **Nothing crosses without you.**
   - Shot: the Finish tab, "Outbound · crosses the wall".
   - On screen: ticked actions "Push branch", "Open pull request: …", "Comment on ABC-123". The
     user clicks "Confirm and send 3 actions"; the button reads "Finishing…", then "Delivered. The
     pull request is linked below.". The CI badge goes from "CI running" to "CI passed".
   - Motion: back on the grid, the dot bursts into a green supernova and settles into the calm done
     pulse.
9. **Clear the deck.**
   - Shot: Ctrl+click the green dot ("Done · Ctrl+click to archive").
   - On screen: the dot launches toward the horizon and vanishes. The pane returns to "Nothing on
     deck. Awaiting orders."
   - Motion: the 900ms launch.
   - End card: the wordmark on the grid, with "Agents work inside. Nothing crosses the wall without
     you."
