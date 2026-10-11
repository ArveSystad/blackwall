---
name: blackwall-motion
description: >
  Motion and animation in apps/web: keyframes, `--animate-*` tokens, pulses, glows, transitions,
  lasers and booms, GridBackdrop and backdrop effects, reduced motion and light-theme overrides.
  Use for ANY animation work in apps/web, e.g. "make it animate", "add a pulse/glow", "fade this
  in", "animate the backdrop".
---

# blackwall motion

Motion in blackwall marks state, never decoration. It is pure CSS in `apps/web/src/styles.css`; JS
only remounts elements (via `key`) and sets CSS variables. This skill adds the motion specifics on
top of `blackwall-design`, which owns tokens and color semantics.

## Communication style

Follow the `caveman` skill for narration and status updates. Code, UI copy and commit text stay normal prose.

## Sources of truth

1. `apps/web/src/styles.css`: the `--animate-*` tokens in `@theme inline`, the `@keyframes bw-*`
   rules after it, and the commented `.bw-*` blocks in `@layer components` (`bw-grid*` for
   GridBackdrop.tsx, `.bw-stream` for TaskHeader.tsx, `.bw-laser`, `.bw-boom` and `.bw-launch` for
   GridAgents.tsx).
2. `.claude/skills/blackwall-design/SKILL.md` § Color semantics / Rules: the state-only rule and its
   two decorative exceptions (GridBackdrop, Stats).
3. Reference code: `apps/web/src/components/GridBackdrop.tsx`, `apps/web/src/components/GridAgents.tsx`,
   `apps/web/src/routes/Stats.tsx`, `apps/web/src/routes/Backlog.tsx`, `apps/web/src/agent-dots.ts`,
   `apps/web/src/components/use-archive-launches.ts`.

Code wins over this skill. Flag any conflict instead of silently picking one.

## Procedure

1. Confirm the motion marks state, or falls under the GridBackdrop/Stats exception. Otherwise don't
   animate.
2. Search the existing `bw-*` keyframes and `--animate-*` tokens; reuse one if it fits.
3. Add `@keyframes bw-<name>` next to the others.
4. Expose it one of two ways:
   - Utility: add `--animate-<name>: bw-<name> <dur> <easing> <fill/iteration>;` in `@theme inline`,
     with a one-line comment when its behaviour isn't obvious, then use `animate-<name>` in className.
   - Multi-part effect: add a `.bw-<name>` class in `@layer components` under a
     `/* ---------- <what> (<Component>.tsx) ---------- */` header. The comment says what the effect
     is, how it ends and how reduced motion handles it.
5. Add a light override that drops `filter: drop-shadow`, `box-shadow` glow or blooms:
   `:root[data-theme="light"] .bw-<name>`, commented `/* Glow is dark only. */`. A glow driven by a
   token (e.g. `--glow-text-pushed`) can instead set that token to `none` in the light theme.
6. Handle reduced motion. Loops are stopped by the base rule (`animation: none !important;
   transition: none !important`). An effect whose resting state is transparent, or that would freeze
   mid-flight, goes into the components-layer `@media (prefers-reduced-motion: reduce)`
   `display: none` list next to `.bw-laser`, `.bw-boom` and `.bw-launch`.
7. If a duration or delay is mirrored elsewhere (another CSS rule or a TS constant), state the
   pairing in the CSS comment and next to the constant.
8. Run the Checks.

## Rules

- Animate only `transform`, `opacity` and `background-position`. Exceptions: `box-shadow` for the
  state pulses (`bw-pulse`, `bw-pulse-needs`, `bw-pulse-done`) and `text-shadow` for one-shot glows
  like `bw-pushed-glow`. Static glows (e.g. `.bw-boom::after`, `.bw-grid-horizon`) are fine; they
  just don't animate. Never animate layout properties (width, height, top, left, margin).
- Colors come from tokens only: `var(--cyan)`, `--st-*`, `--grid-*`, `color-mix(...)`. No raw hex in
  keyframes or effect classes.
- Glow is dark only. Every glowing effect needs a light override.
- Reduced motion: never leave a frozen one-shot visible.
- Paired timings. Change both sides together and document the pairing:
  - Boom period = 2 × pulse period (3.2s/2.8s vs 1.6s/1.4s); boom delay = `--pulse-delay`.
  - `--animate-pulse-running` 1.6s ↔ `PULSE_RUNNING_S`, `--animate-pulse-needs` 1.4s ↔
    `PULSE_NEEDS_S`, `--animate-pulse-done` 2.4s ↔ `PULSE_DONE_S` (all in `agent-dots.ts`).
  - `.bw-launch` 900ms ↔ `LAUNCH_MS` in `use-archive-launches.ts`.
- Retrigger a one-shot by changing its React `key` (a counter or timestamp) so it remounts, as in
  `GridAgents.tsx` (`<span key={lasers} className="bw-laser" />`) and `Backlog.tsx`
  (`<span key={note.at} className="animate-pushed-glow">`). Never toggle classes with timers.
- Mount-only animations follow `animate-bar-grow` (Stats.tsx: `origin-bottom animate-bar-grow`):
  fill mode `both`, set `transform-origin`, and don't animate later value changes.
- GridBackdrop:
  - Its parent is `relative` (Stats adds `isolate overflow-hidden`) and does not scroll. Scrolling
    content lives in a `relative z-10` sibling.
  - Centred content stays within the ~520px faded column (`calc(50% ± 260px)`, Stats uses
    `max-w-[520px]`) unless `fade={false}`.
  - Never put it behind a task view, Settings or modals.
  - The only JS is the pointer spotlight's `--mx`/`--my`.
- Neon and motion mark state only (`blackwall-design` § Color semantics / Rules). GridBackdrop and
  Stats are the only sanctioned decorative exceptions.
- When a motion pattern, token or pairing changes, update this skill in the same commit.

## Checks

- `pnpm typecheck` and `pnpm lint`.
- In the browser, check both themes (`T`) and the OS reduced-motion setting: loops stop, one-shots
  never stick.
- After changing a timing, grep for the paired value (e.g. `rg -n "2.4s|PULSE_DONE_S" apps/web/src`).

## Changing this skill

When a motion pattern, token or pairing changes, update this skill in the same commit so it never
contradicts the code.
