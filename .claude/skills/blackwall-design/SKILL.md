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
| Severity Critical / High / Medium / Low | `--sev-*` | #ff4d5e / #ff8b3d / #f2c14e / #8e9dbc | #cf2236 / #c2530a / #9a6d00 / #5a6880 |
| Diff add / del | `--diff-add-*` / `--diff-del-*` | plain GitHub-style green/red | same |
| First-run backdrop lines / glow (decoration, first run only) | `--grid-line` / `--grid-glow` | primary 34% / cyan 16% (`color-mix`) | border-strong 80% / none |

Surfaces in dark run from near-black indigo to dusky violet: `bg-0` page, `bg-1` panes,
`bg-2` cards and inputs, `bg-3` hover and selected, `bg-4` popovers. Body text is muted off-white
(`--fg` #c4c1d9). Never use pure white for text.

Rules:
- Neon and glow mark **state**, never decoration. Allowed on focus rings, the needs-you rail, banner
  and CTA, running dots, the active tab underline, and the current stepper node.
- One deliberate exception: the first-run backdrop (`GridBackdrop`, an animated perspective grid) is
  the only decorative use of glow. It stays low-opacity, uses primary/cyan only (via `--grid-line` /
  `--grid-glow`), fades out under the setup cards, stops under reduced motion, and never appears on
  working screens (inbox with tasks, task view, settings).
- Never put glow or neon on diffs, transcripts, long text, or table rows.
- Glow is dark only. Light replaces it with a 1px border plus a 3px tinted ring (`--glow-*` handles this).
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
- Radii: tag 3, chip/kbd 4, button/input 6 (`--radius`), card 8, dialog 12.
- Compact rows, little chrome. Use whitespace instead of a border wherever one would do. Never use
  left-border accent cards (the needs-you rail is the one sanctioned exception).

## Layout

- **Shell:** inbox on the left (~352px), task view on the right. Settings replaces both panes with
  a settings nav, a list and an editor.
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
- **Modals** (new task, missing token): over a dimmed shell, Esc closes, ⌘↵ / ↵ submits. Never display
  tokens; show configured or missing status only.

## Components (canonical names; keep them)

`StatusBadge`, `SeverityChip`, `StagePips`, `StageStepper`, `AgentTile` (CC/CP placeholders until
real CLI marks are added), `TaskCard`, `NeedsBanner`, `FindingRow` (expandable: why + suggested-fix
diff + Force fix / Force ignore), `DiffView`, `ToolCall` (collapsible: verb + mono target + result),
`Kbd`, `Segmented`, `OutboundAction`. Mockup class names map 1:1 (`.status`, `.sev`, `.pips`,
`.stepper`, `.agent`, `.tcard`, `.needs-banner`, `.frow`, `.dl`, `.tool`, `.kbd`, `.seg`).

## Keyboard

J/K move · Enter open · G N next needs-you · N new task · / search · ⌘↵ confirm/send · F force fix ·
I force ignore · O open in editor · A approve plan · R request changes (Grill) / resume (interrupted) ·
P pause · T toggle theme · Esc close · ? shortcut sheet. Show `Kbd` hints next to the actions they trigger. Never
bind a global shortcut while focus is in a text field.

## Copy

- Short and direct, written for developers. Say what happened and what the user can do next.
- No exclamation marks or emoji, and nothing cute in error messages.
- Name things exactly: "Push `feature/x` to github.com/acme/web", not "Sync changes".
- Tab title: `(N) blackwall`, where N is the needs-you count, or plain `blackwall` when zero.

## Accessibility

- Use real `<button>`, `<a>` and `<input>` + `<label>` elements. Icon-only buttons need an `aria-label`.
- Contrast: 4.5:1 for text. `--fg-faint` is for non-essential text only.
- States must never rely on color alone: pair each with an icon, a label or an animation
  (running pulse, needs-you blink).
- Respect `prefers-reduced-motion`: stop the pulse, blink, caret and stream-sweep animations.

## Changing the design itself

New screens or a visual change of direction start in the Claude Design canvas, then are re-exported
to `docs/design/`. When a design decision changes, update this skill in the same commit so it never
contradicts the code.
