# blackwall UI design

Exported from the Claude Design canvas. These are reference mockups, not production code.

## Files

- `bw.css` holds the **source of truth for tokens**: colors for both themes (`.bw[data-theme="dark|light"]`), status, severity, diff, glows, radii and fonts, plus primitive component styles (btn, chip, sev, status, tabs, stepper, findings row, diff lines, task card).
- `Tokens.dc.html` is the token sheet, including the Tailwind v4 `@theme inline` mapping onto shadcn/ui slots.
- `*.dc.html` files are the screens, one per file. Each is HTML with `{{holes}}`, `<sc-for>`/`<sc-if>` loops and conditionals, and a `renderVals()` class holding the sample data. Read them as layout and markup reference and translate them to React + shadcn/ui; don't port the runtime.
  - `Main`: two-pane shell, a task in code review, findings triage
  - `Inbox`: left pane task list (needs you → running → recent)
  - `Grill`: plan review with the Q&A interview and plan approval
  - `Finish`: summary and outbound action confirmation
  - `NewTask`, `Settings` (agent library), `TokenModal`
  - `Running`, `Exceptions` (interrupted + failed), `FirstRun` (empty state)
  - `*Light.dc.html` render the same screen with `theme="light"`
- `canvas.json` is the canvas layout index. You can ignore it.

## Rules the design relies on

- Cyan means an agent is working (running, focus ring). Magenta means a human is needed. Violet is the primary action and selection. Keep these meanings fixed.
- "Needs you" is the loudest state: the magenta rail on inbox cards, the banner in the main view, and the magenta CTA.
- Severity is Critical (red), High (orange), Medium (amber) or Low (slate). Critical and High gate the review loop and show a lock icon.
- Diffs use plain green and red. Never put neon or glow on diffs, text blocks or table rows.
- Glow is dark-theme only. Light theme replaces it with a 3px tinted ring.
- The UI is keyboard-first: J/K to move, G N for the next task needing you, ⌘↵ to confirm, F/I to force fix or ignore a finding.
- The "CC" and "CP" tiles are placeholders for the real Claude Code and Copilot CLI icons.
- Fonts: Geist (UI), Geist Mono (code, paths, branches, hashes), Chakra Petch (wordmark only).
