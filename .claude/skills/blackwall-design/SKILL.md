---
name: blackwall-design
description: >
  blackwall's visual design system and UI rules: tokens, color semantics, layout, components,
  keyboard model, dark/light themes. Use for ANY work on apps/web UI — building or changing a
  screen, component, style, color, icon, empty/error state, or theme; porting a mockup from
  docs/design/; reviewing UI code for consistency. Also use when asked "how should X look",
  "add a badge/chip/status", "style this", or when a task in tasks/ touches the web app.
---

# blackwall design

blackwall is a control room at the boundary: agents work freely inside worktrees, nothing leaves
the machine without the user's say-so. The UI is dense, keyboard-first and calm to read, with neon
used only to signal state. Users are senior developers who keep it open beside the IDE.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, UI copy and commit text stay normal prose.

## Sources of truth

1. **Tokens in code.** Once task-008 has landed, the app's token stylesheet is authoritative. Find it
   with `grep -rl -- "--st-needs" apps/web/src`. Until then, use `docs/design/bw.css`.
2. **Mockups:** `docs/design/*.dc.html`, one screen per file (see `docs/design/README.md`). They are
   reference for layout, density, copy and states. Do not port the template runtime (`{{holes}}`,
   `<sc-for>`, `<sc-if>`, `renderVals`); rebuild as React + Tailwind + shadcn/ui (Radix).
3. **Brief:** `claude-design.md` (what and why). Product behaviour: `grill-result.md`.

If code and mockup disagree, the code tokens win for values and the mockup wins for intent. Flag the
conflict instead of silently picking one.

## Procedure for any UI change

1. Read the relevant mockup(s) in `docs/design/` and the token file before writing code.
2. Reuse existing components and tokens. Search `apps/web/src/components` first. Add a component only
   when none fits, and build it on a shadcn/Radix primitive.
3. Style only with tokens (Tailwind utilities mapped via `@theme inline`). **No raw hex, rgb or
   arbitrary color values in components.** If a value is missing, add a token to BOTH themes, map it in
   `@theme inline`, and record it in the token table below.
4. Build both themes. Dark is the primary target; light must use the same layout and semantics.
   Dark is always the default. Light is opt-in only, via the theme toggle or `T`, which sets
   `data-theme="light"` on `<html>` (stored per browser in `localStorage`). Never follow the OS
   `prefers-color-scheme`.
5. Cover every state the screen can be in: loading, empty, needs you, running, interrupted, failed, done.
6. Make it work from the keyboard (see Keyboard) with visible focus rings.
7. Check: `pnpm typecheck`, `pnpm lint`, then compare against the mockup in the browser in both themes.

## Color semantics (fixed; never repurpose)

| Meaning | Token | Dark | Light |
|---|---|---|---|
| Machine is working: running, live stream, focus ring | `--cyan` / `--st-running` / `ring` | #2ee6ff | #1d6fe0 |
| **Human is needed** (the loudest state in the app) | `--magenta` / `--st-needs` | #ff3dcf | #c4167c |
| Primary action, selection, active tab | `--primary` | #a77bff | #5a45e0 |
| Interrupted | `--st-interrupted` | #a8a2cc | #6b6b7b |
| Failed / destructive | `--st-failed` | #ff5c78 | #cf2236 |
| Done | `--st-done` | #5cd69a | #1a7f37 |
| New work just assigned (one-shot pill boom only) | `--st-assigned` | #ffe14d | #a37a00 |
| Severity Critical / High / Medium / Low | `--sev-*` | #ff4d5e / #ff8b3d / #f2c14e / #8e9dbc | #cf2236 / #c2530a / #9a6d00 / #5a6880 |
| Diff add / del | `--diff-add-*` / `--diff-del-*` | plain GitHub-style green/red | same |
| Empty-pane and Stats backdrop lines / glow (decoration only) | `--grid-line` / `--grid-glow` | primary 44% / cyan 24% (`color-mix`) | border-strong 80% / none |
| Stats headline number and chart bars (`shadow-glow-done`, `text-shadow-glow-done`) | `--glow-done` / `--glow-text-done` | `--st-done` ring + 14px glow / 10px text glow | 1px #1a7f37 border + 3px tinted ring / none |

Surfaces in dark run from near-black indigo to dusky violet: `bg-0` page, `bg-1` panes,
`bg-2` cards and inputs, `bg-3` hover and selected, `bg-4` popovers. Body text is muted off-white
(`--fg` #c4c1d9). Never use pure white for text. The repo picker in the context bar is a themed
dropdown on the popover surface (`bg-4`) and marks favourites with a filled primary star.

Rules:
- Neon and glow mark **state**, never decoration. Allowed on focus rings, the needs-you rail, banner
  and CTA, running dots, the grid's running headline, the active tab underline, and the current
  stepper node.
- One deliberate exception: the empty-pane backdrop (`GridBackdrop`, an animated perspective grid) is
  the only decorative use of glow. It is the main pane's resting background whenever no task is
  selected (first-run setup or the active agents). It stays low-opacity, uses primary/cyan only (via
  `--grid-line` / `--grid-glow`), stops its animation under reduced motion, and never appears behind
  a task view, Settings or modals. By default (`fade`) its lines fade to about 18% under a ~520px
  centre column in the centred states: first run, "Nothing on deck. Awaiting orders.", the load error and Stats.
  Behind the agents view (active tasks, plus done tasks until they are archived) the grid runs full
  width (`fade={false}`, `.bw-grid-full`); do not bring the centre fade back there. Switching
  between the two eases via the `--grid-fade` transition. A pointer spotlight (`.bw-grid-spot`)
  follows the pointer and ignores touch. It is a `backdrop-filter` over the lines already drawn,
  so it adds no new glow and is part of this exception, not a breach of the state rule. It is
  weaker under the faded column by design, brightens the lines in dark and slightly darkens them
  in light, with no glow. Implementation note: `.bw-grid-full` must keep its `mask-image`, because
  the mask makes `.bw-grid` the backdrop root, so the spotlight filters only the grid.
- On that backdrop, `GridAgents` draws each active task as a small dot on the floor. These glows mark
  state, so they follow the state rule: cyan with `animate-pulse-running` while an agent runs (one dot
  per running step), magenta with `animate-pulse-needs` when the task needs you, faint and static
  when queued. A dot fires a short cyan laser upward when its task changes stage (`.bw-laser`, hidden
  under reduced motion). While any task runs, a centred "N tasks running" headline (`RunningHeadline`,
  Geist semibold uppercase, not Chakra Petch) in running cyan with `--glow-text-cyan` sits above the
  horizon, and the pointer brightens it locally. Each dot is a 24px link to its task, centres are at least 28px apart, and
  needs-you dots stack above running and queued ones; hover or focus shows a card with the task,
  stage and current work. "Nothing on deck. Awaiting orders." and Create task show only when nothing is
  active, with View backlog for the selected repo beside it, or "Backlog clear. Nothing queued." when nothing waits there; if the
  tasks or agents cannot load, the pane says so with Retry instead. The home grid also has a
  review-requests pill at the bottom, under the floor: magenta (count and blinking dot) while pull
  requests need the user, muted otherwise; it is a solid popover pill, not a glow. When a pill's count
  rises from zero it booms yellow once (`--st-assigned`), then settles to magenta.
- The Stats screen (`/stats`) is the second sanctioned exception. It may use `GridBackdrop` behind
  its content (the backdrop's parent does not scroll; content scrolls in a sibling and stays within
  the ~520px faded column; Stats keeps the default `fade` and gets the same pointer spotlight), and
  the done-tinted glow (`--glow-done` / `--glow-text-done`, i.e. `shadow-glow-done` and
  `text-shadow-glow-done`) on its headline number and chart bars only. In light these become a ring
  or none, like the other glows. Chart bars grow in once on mount (`animate-bar-grow`); later height
  changes are not animated.
- Never put glow or neon on diffs, transcripts, long text, or table rows.
- Glow is dark only. Light replaces it with a 1px border plus a 3px tinted ring (`--glow-*` handles this).
- Chamfered surfaces (see Density and shape) keep their glow through the `--drop-glow-*` / `--drop-pop`
  tokens, never through `box-shadow`, because `clip-path` drops an element's own shadow. Three
  mechanisms: buttons use the `drop-shadow-glow-*` utility on the unclipped button (the fill is a
  clipped `::before`); dialogs put `drop-shadow-pop` on the unclipped Radix `Content` around the
  clipped panel; `NeedsBanner` uses a `.bw-chamfer-halo` sibling, since its wash is translucent.
- Severity colors never mean status, and status colors never mean severity.
- Anything that needs the user uses magenta: magenta rail and wash on inbox cards, the banner in the
  main view, and the magenta button for the action that resolves it. Only needs-you uses magenta.
- Critical and High findings gate the review loop. Always show the lock (gate) icon next to them.
- Primary CTA is violet (`btn-primary`). The CTA that resolves a needs-you state is magenta (`btn-needs`).
  Use at most one of each per view.

## Typography

- **Geist** for the UI; **Geist Mono** for agent output, code, diffs, file paths, branch names,
  commit hashes, issue/PR keys and keyboard hints.
- **Chakra Petch** only for the wordmark and first-run hero. Nowhere else.
- Scale (px size/line height): title 18/24 semibold; heading 15/20 semibold; body 13/20; meta 12/18;
  label 11/16 semibold uppercase with 0.06em letter-spacing; mono 12/19.
- Do not use Inter, Roboto or Arial.

## Density and shape

- Spacing uses a 4px base. Heights: table row 40, tab 36, button 28 (sm 24), input 30, chip 20.
- Radii: tag 3, chip/kbd 4, button/input 6 (`--radius`), card 8, dialog 12 (but see the radii
  exceptions below).
- Radii exceptions (HUD chrome, `.bw-chamfer*` in `styles.css`): `btn-primary`, `btn-needs`,
  `NeedsBanner` and every dialog panel are square, with the top-left and bottom-right corners cut by
  8px. They have no radius and no CSS border: the frame line is an `::after`. Button focus is a 2px
  inset line in the button's own foreground colour (`currentColor`: `--primary-fg` / `--needs-fg`),
  never `--fg-strong` or cyan, which fall under 3:1 on the fills. The task header carries
  `.bw-brackets`, four corner brackets that turn cyan on focus-within.
- Compact rows, little chrome. Use whitespace instead of a border wherever one would do. Never use
  left-border accent cards (the needs-you rail is the one sanctioned exception).

## Layout

- **Shell:** inbox on the left (~352px), task view on the right. Settings replaces both panes with
  a settings nav, a list and an editor.
- **Stats:** a full page at `/stats`, opened from the icon button next to the Settings cog in the
  inbox header. Its top-left header (wordmark, theme toggle, "Inbox" back button with `Esc`) mirrors
  Settings so the wordmark stays put. It shows tasks resolved, a tile per task type, repositories
  touched and a per-day bar chart of the last 10 days.
- **Inbox:** grouped Needs you → Running → Recent. Each card shows: origin icon + key (mono), relative
  time, 2-line title, needs-you reason (magenta), repo (mono), 6-pip stage indicator, agent tiles and
  a status badge.
- **Task view:** header (origin link, mode chip, title, repo, branch, agents, stage stepper with
  review round), then the needs-you banner if any, then tabs (Context, Plan, Grill, Agent output,
  Findings, Diff, Checks) with counts in mono, then content, then the input bar to steer agents.
- **Stages, always in this order:** Inform → Plan review → Implement → Checks → Code review → Finish.
- **Grill:** a structured interview, not chat. Each question shows a number, a status chip, the
  reviewer's identity, the planner's take, and quick answers with 1/2/3 key hints. Approve plan stays
  disabled while any decision is open, with an explicit "approve anyway" link.
- **Finish:** the outbound panel ("crosses the wall") lists every outward action as a pre-ticked
  checkbox showing exactly what is sent (branch → remote, PR title/base, comment text). Optional
  actions start unticked. One confirm button states the count, e.g. "Confirm and send 3 actions".
  Nothing outward happens anywhere else in the UI.
- **Chat:** a right-hand panel beside every page (shell, Settings, Stats), toggled by the top bar's
  chat button or `C`. It follows the repo picked in the top bar ("No channel. Pick a repo to chat about it."
  otherwise). Its preferred width is 250–900px (default 380px), remembered per browser with the open
  state; the rendered width re-clamps live so the main area keeps at least 360px beside the 352px
  sidebar. It never overlays the page and never closes itself; below ~960px it stays at 250px and
  the main area shrinks. The left edge is a separator: an 8px hit area over a 1px `border` line that
  turns 2px cyan on hover, while dragging and on keyboard focus (with the focus ring); Left/Right
  step 16px, Home/End jump to the bounds. Opening has no animation. Only messages appended while the
  panel is open fade in (`animate-fade-in`, 150ms); history never does. States: loading, load
  error with Retry, empty, busy (a cyan activity line with the running pulse; Send is disabled
  except for `/clear`), send error inline. Clear (and a typed `/clear`) clears at once when idle,
  and asks first ("Stop and clear the chat?") only while an answer is running.
- **Search palette:** `⌘K` / `Ctrl K` or the top bar's search button opens a dialog anchored near
  the top (640px). The input keeps focus (combobox) over a listbox grouped Tasks → Backlog → Repos,
  each with a `label` heading; the active row is `bg-muted` with a cyan border. An "All repos" /
  "This repo" `Segmented` sets the scope (the selected repo comes first either way; disabled with
  no repo). Rows: origin icon, title, mono key and repo, status (or an Archived chip), and a faint
  snippet line when the match is outside the title. ↑/↓ (and Ctrl N/P) wrap, ↵ opens, Esc closes.
- **Modals** (new task, missing token): over a dimmed shell, Esc closes, ⌘↵ / ↵ submits. Never display
  tokens; show configured or missing status only.

## Components (canonical names; keep them)

`StatusBadge`, `SeverityChip`, `StagePips`, `StageStepper`, `AgentTile` (CC/CP placeholders until
real CLI marks are added), `TaskCard`, `NeedsBanner`, `FindingRow` (expandable: why + suggested-fix
diff + Force fix / Force ignore), `DiffView`, `ToolCall` (collapsible: verb + mono target + result),
`Kbd`, `Segmented`, `OutboundAction`, `ChatPanel` (with its action cards: a summary label such as
"Request changes · planner", the task title linked to the task with its status pill, the gate
reason, and the full message or a clamped description with Show more), `ChatToggle`, `SearchPalette`. Mockup class
names map 1:1 (`.status`, `.sev`, `.pips`, `.stepper`, `.agent`, `.tcard`, `.needs-banner`,
`.frow`, `.dl`, `.tool`, `.kbd`, `.seg`).

Chat card buttons are `size="sm"` and say Apply (Done once applied). `create-task` and
`resume-task` use `default`, `stop-task` uses `destructive-ghost`, and only the first available
`message-task` card of the newest reply uses `needs`; the rest use `default`. Send is the chat's
only `primary` button.

## Keyboard

J/K move · Enter open · G N next needs-you · N new task · / filter inbox · ⌘K / Ctrl K search palette · ⌘↵ confirm/send · F force fix ·
I force ignore · O open in editor · A approve plan · R request changes (Grill) / resume (interrupted) ·
P pause · T toggle theme · C toggle chat · Esc close · ? shortcut sheet. Show `Kbd` hints next to the actions they trigger. Never
bind a plain-key global shortcut while focus is in a text field; ⌘/Ctrl shortcuts (⌘S, ⌘K) may fire there.

## Copy

- Short and direct, written for developers. Say what happened and what the user can do next.
- No exclamation marks or emoji, and nothing cute in error messages.
- Name things exactly: "Push `feature/x` to github.com/acme/web", not "Sync changes".
- Tab title: `(N) blackwall`, where N is the needs-you count, or plain `blackwall` when zero.
- Control-room voice:
  - Pattern: a short operator status, then the plain fact or next step. A loading line is a
    present-tense verb, then the named object, then "…".
  - Examples: "Nothing on deck. Awaiting orders.", "Pulling the task list…", "Clean sweep. No
    findings.", "Wall secure. Nothing leaves.", "Restore complete. Imported the export from …".
  - Applies to empty states, loading lines, success confirmations, and the subtitle and body lines
    of empty panes.
  - Never applies (keep these plain and exact): errors and load failures, destructive
    confirmations, Finish outbound descriptions and action text, button pending labels, status
    chips, and count-pill labels (they are also accessible names).
  - Rules: sentence case, short, no emoji, no exclamation marks. Every line names what is loading,
    missing or done, and a metaphor never replaces the object ("Tapping the output stream…", not
    "Tapping the stream…"). Keep a second sentence that tells the user what happens next, and keep
    the facts in success lines (dates, paths).

## Accessibility

- Use real `<button>`, `<a>` and `<input>` + `<label>` elements. Icon-only buttons need an `aria-label`.
  Icon-only header buttons and links also carry a native `title` as a hover tooltip.
- Contrast: 4.5:1 for text. `--fg-faint` is for non-essential text only.
- States must never rely on color alone: pair each with an icon, a label or an animation
  (running pulse, needs-you blink).
- Respect `prefers-reduced-motion`: stop the pulse, blink, caret and stream-sweep animations.

## Changing the design itself

New screens or a visual change of direction start in the Claude Design canvas, then are re-exported
to `docs/design/`. When a design decision changes, update this skill in the same commit so it never
contradicts the code.
