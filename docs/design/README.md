# blackwall UI design

Start with [BRIEF.md](BRIEF.md) for the current product and design.

The `.dc.html` files were exported from the Claude Design canvas. They are reference mockups, not
production code, and they predate parts of the app (see [Drift between mockups and app](#drift-between-mockups-and-app)).

## Files

- `apps/web/src/styles.css` (not in this folder) is now the **source of truth for tokens**.
  `bw.css` is the historical export it started from: colours for both themes
  (`.bw[data-theme="dark|light"]`), status, severity, diff, glows, radii and fonts, plus primitive
  component styles (btn, chip, sev, status, tabs, stepper, findings row, diff lines, task card).
- `Tokens.dc.html` is the token sheet, including the Tailwind v4 `@theme inline` mapping onto shadcn/ui slots.
- `*.dc.html` files are the screens, one per file. Each is HTML with `{{holes}}`, `<sc-for>`/`<sc-if>` loops and conditionals, and a `renderVals()` class holding the sample data. Read them as layout and markup reference and translate them to React + shadcn/ui; don't port the runtime.
  - `Main`: two-pane shell, a task in code review, findings triage
  - `Inbox`: left pane task list (needs you → running → recent)
  - `Grill`: plan review with the Q&A interview and plan approval
  - `Finish`: summary and outbound action confirmation
  - `NewTask`, `Settings` (agent library), `TokenModal`
  - `Running`, `Exceptions` (interrupted + failed), `FirstRun` (empty state; the mockup has a plain `--bg-0` background, while the app draws the animated grid backdrop with the active agents as dots on its floor; see [BRIEF.md § 5](BRIEF.md#5-the-grid-backdrop-screen))
  - `*Light.dc.html` render the same screen with `theme="light"`
- `canvas.json` is the canvas layout index. You can ignore it.

## Rules the design relies on

- Cyan means an agent is working (running, focus). Magenta means a human is needed. Violet is the primary action and selection. Keep these meanings fixed.
- "Needs you" is the loudest state: the magenta rail on inbox cards, the banner in the main view, and the magenta CTA.
- Severity is Critical (red), High (orange), Medium (amber) or Low (slate). Critical and High gate the review loop and show a lock icon.
- Diffs use plain green and red. Never put neon or glow on diffs, text blocks or table rows.
- Glow is dark-theme only. Light theme replaces it with a 3px tinted ring, and the focus ring is violet instead of cyan.
- Every radius is 0. Corners are chamfered (8px top-left and bottom-right; 5px on pills; 3px on checkboxes), and focus is a 2px cyan frame line.
- In the app, dark is always the default; light is opt-in via the top bar toggle or `T` (never the OS setting).
- The UI is keyboard-first: N new task, / filter, C chat, Ctrl+K (⌘K) search, T theme, ⌘↵ to confirm, F/I to force fix or ignore a finding, J/K to move in the Backlog.
- The "CC", "CP" and "OC" tiles are placeholders for the real Claude Code, Copilot CLI and OpenCode icons.
- Fonts: Geist (UI), Geist Mono (code, paths, branches, hashes), Chakra Petch (wordmark and display headings only).

## Drift between mockups and app

The app (`apps/web/src`) wins wherever these differ. As of `295dafe`:

- **Corners:** the mockups use rounded radii; the app is radius 0 everywhere, with chamfered corners (`.bw-chamfer*` in `styles.css`).
- **Top bar:** Stats, Settings, the theme toggle, chat and search have moved into a global 44px top bar with the wordmark and repo picker; the mockups put them in pane headers.
- **Task view:** there is no input bar. Steering moved to the direct send (⌘⇧↵) in the task view's task channel.
- **Tabs:** the app has nine (Context, Plan, Grill, Agent output, Findings, Diff, Artifacts, Checks, Finish); the mockups lack Artifacts and Finish as tabs.
- **Grill:** the app has no 1/2/3 quick answers and no "approve anyway" link; each question takes a typed answer, and Approve plan stays locked until the open questions are answered.
- **Inbox footer:** the button reads "Archive N done" (title "Archive all done tasks").
- **Keyboard:** the inbox has no J/K or G N bindings (J/K move in the Backlog only), and there is no `O` or `?` binding.
- **Screens with no mockup:** Backlog and Archive, Stats, Chat, Search palette, Review requests, Assigned issues, Active agents, and the home grid with agent dots.
- **Agents:** OpenCode (`OC`, `--opencode`) sits beside CC and CP.
