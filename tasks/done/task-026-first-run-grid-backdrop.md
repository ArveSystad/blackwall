---
id: task-026
title: Animated sci-fi grid backdrop on the first-run screen
status: backlog
depends_on: [task-021, task-025]
---

## Goal
The empty app (first run, before any connection, repo or task exists) is the first thing a new user
sees. Give it atmosphere: a subtle, slowly animated cyberpunk/sci-fi grid behind the setup steps, in
the spirit of a "control room at the boundary". It should look striking in dark theme and stay calm
and readable in light theme. It is decoration only, so it must never compete with the setup steps or
the cyan "current step" glow.

## Current state
- `apps/web/src/routes/Home.tsx` renders `FirstRun` (three `SetupStep` cards: connection, repo, first
  task) centered in the right pane when there is nothing set up yet. Mockup:
  `docs/design/FirstRun.dc.html` (plain `var(--bg-0)` background today).
- Tokens live in `apps/web/src/styles.css` (dark on `:root`; after task-025, light only under `:root[data-theme="light"]`). Tailwind utilities are mapped in `@theme inline`.
- task-021 rebuilds the main view and may move or change the empty state; build on whatever it leaves.

## Design direction
- **Look:** a perspective "synthwave floor" grid receding toward a horizon, or a flat fine grid with a
  soft radial vignette, plus one or two slow effects. Pick from:
  - grid lines drifting slowly toward the viewer (translate a repeating gradient, ~20–40 s loop),
  - a faint horizontal scanline sweep every several seconds,
  - occasional grid nodes/intersections pulsing faintly,
  - a soft horizon glow behind the wordmark/steps.
  Keep it to at most two moving effects. Slow and low-contrast beats busy.
- **Color:** derive everything from existing tokens (`--primary`, `--cyan`, `--bg-*`, `--border`) via
  `color-mix()` at low opacity, never raw hex in components. Do **not** use magenta (reserved for
  needs-you) or status/severity colors. If a new token is needed (e.g. `--grid-line`, `--grid-glow`),
  add it to BOTH themes, map it in `@theme inline`, and record it in the skill's token table.
- **Dark theme:** violet/cyan lines on near-black indigo, with a little bloom. This is where it shines.
- **Light theme:** same grid, rendered as thin cool-gray lines with no glow (the design rule is that
  glow is dark only).
- **Readability:** the setup cards sit above it with their own `bg-sidebar` surface; text contrast
  must stay ≥ 4.5:1. Fade the grid out under the card column (mask/vignette) so lines never run behind
  text at full strength.

## Implementation notes
- Pure CSS preferred: an absolutely positioned, `pointer-events-none`, `aria-hidden` layer
  (e.g. `components/GridBackdrop.tsx`) using `repeating-linear-gradient` / `linear-gradient` grids,
  `perspective` + `rotateX` for the floor, `mask-image` for the fade, and `@keyframes` for motion.
  Animate only `transform`/`opacity`/`background-position` so it stays on the compositor. No canvas or
  WebGL unless CSS genuinely cannot do it; no new dependencies.
- Render it only in the first-run empty state, scoped to the right pane (not under the inbox).
- `prefers-reduced-motion: reduce` → static grid, no animation.
- Pause animation when the tab is hidden is free with CSS; make sure nothing runs in JS per frame.

## Design-skill update
The `blackwall-design` skill says "Neon and glow mark **state**, never decoration." This backdrop is a
deliberate, single exception. In the same commit, update `.claude/skills/blackwall-design/SKILL.md`
Rules to say: the first-run backdrop is the only decorative use of glow; it must stay low-opacity, use
primary/cyan only, and never appear on working screens (inbox with tasks, task view, settings). Also
update `docs/design/README.md` if it describes the FirstRun screen's background.

## Acceptance criteria
- With no connections, repos or tasks, the first-run screen shows the animated grid behind the setup
  steps; once the app has tasks, the normal screens show no grid.
- Dark theme looks rich; light theme shows a subtle static-feeling grid with no glow; both match the
  rest of the UI's palette.
- Setup step text and the cyan current-step highlight remain clearly the most prominent elements.
- With reduced motion enabled, nothing animates.
- No layout shift, no scrollbars introduced, smooth on a normal laptop (no per-frame JS).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass; screenshots checked in the browser in both themes.

## Refs
`apps/web/src/routes/Home.tsx`, `apps/web/src/styles.css`, `docs/design/FirstRun.dc.html`,
`.claude/skills/blackwall-design/SKILL.md`, task-025 (theme override)
