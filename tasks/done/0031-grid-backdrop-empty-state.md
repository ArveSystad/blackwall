---
id: task-0031
title: Grid backdrop behind "No task selected"
status: backlog
depends_on: []
---

## Goal
Show the animated grid backdrop from task-026 in the main pane whenever no task is selected, not only on the first-run screen.

## Motivation
task-026 added `GridBackdrop` (`apps/web/src/components/GridBackdrop.tsx`), but `Home.tsx` only renders it when the repo has no tasks yet. Once tasks exist, the empty main pane ("No task selected") is plain. The backdrop should be the app's resting background.

## Scope
- `apps/web/src/routes/Home.tsx` (`~line 124–140`): render `<GridBackdrop />` unconditionally in the no-task-selected pane, not just under `firstRun`:
  ```tsx
  <GridBackdrop />
  {firstRun ? <FirstRun /> : <NoTaskSelected />}
  ```
- Make sure the "No task selected" prompt sits above the backdrop (`relative z-*`) and stays readable over the horizon glow. Check the fade mask in `.bw-grid*` (`apps/web/src/styles.css`), which was tuned to fade under the first-run setup cards. Adjust it so the centred one-line prompt also reads cleanly, without making first-run worse.
- Update the comment in `GridBackdrop.tsx` ("behind the first-run setup steps") and the blackwall-design skill and `docs/design/README.md` notes that say the backdrop is first-run only.
- Still never behind a task view, Settings or modals.

## Acceptance criteria
- With tasks present and none selected, the main pane shows the animated grid in dark and the plain grid lines in light. It is hidden while a task is open.
- Reduced motion still stops the animation. No horizontal scroll at narrow widths.
- `pnpm build`, `pnpm test` and `pnpm lint` pass.

## Refs
task-026, `apps/web/src/components/GridBackdrop.tsx`, `apps/web/src/routes/Home.tsx`

## Notes
