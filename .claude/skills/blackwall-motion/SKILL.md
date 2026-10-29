---
name: blackwall-motion
description: >
  Motion and animation in apps/web: keyframes, `--animate-*` tokens, pulses, glows, transitions,
  lasers and booms, GridBackdrop and backdrop effects, the wordmark flicker, reduced motion and
  light-theme overrides.
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
   GridBackdrop.tsx, `.bw-stream` for TaskHeader.tsx, `.bw-laser`, `.bw-boom`,
   `.bw-revive`/`.bw-revive-failed`, `.bw-supernova` and `.bw-launch` for GridAgents.tsx, `.bw-assigned`/
   `.bw-assigned-flash` for CountPill.tsx, `.bw-running*` for RunningHeadline.tsx, `.bw-chat`/
   `.bw-chat-content` for ChatPanel.tsx, `.bw-shutter` for SettingsShutter.tsx, `.bw-decrypt*` for DecryptText.tsx,
   `.bw-wordmark-flicker` for Wordmark.tsx, `bw-scan-wipe`/`--animate-scan-wipe` for ui/dialog.tsx), and `bw-route-wipe` with the
   `::view-transition-*(bw-route|bw-inbox|root)` rules for the route wipe (router.tsx, Inbox.tsx,
   route-transition.ts).
2. `.claude/skills/blackwall-design/SKILL.md` § Color semantics / Rules: the state-only rule and its
   five decorative exceptions (GridBackdrop, Stats, the wordmark flicker, the route wipe, the
   Settings shutter scanline).
3. Reference code: `apps/web/src/components/GridBackdrop.tsx`, `apps/web/src/components/GridAgents.tsx`,
   `apps/web/src/components/RunningHeadline.tsx`, `apps/web/src/routes/Stats.tsx`, `apps/web/src/routes/Backlog.tsx`, `apps/web/src/agent-dots.ts`,
   `apps/web/src/components/use-archive-launches.ts`, `apps/web/src/components/use-resume-bursts.ts`,
   `apps/web/src/components/use-supernovas.ts`, `apps/web/src/decrypt.ts`,
   `apps/web/src/components/use-decrypt.ts`, `apps/web/src/chat-stream.ts`,
   `apps/web/src/components/use-chat-stream.ts`, `apps/web/src/settings-shutter.ts`,
   `apps/web/src/components/SettingsShutter.tsx`, `apps/web/src/components/Wordmark.tsx`,
   `apps/web/src/wordmark-flicker.ts`, `apps/web/src/components/use-wordmark-flicker.ts`,
   `apps/web/src/components/use-count-boom.ts` (detects the rise during render and keeps its timer in
   a `[boom]` effect, so StrictMode's effect replay can't strand it).

Code wins over this skill. Flag any conflict instead of silently picking one.

## Procedure

1. Confirm the motion marks state, or falls under the GridBackdrop/Stats/wordmark-flicker/route-wipe/
   shutter scanline exceptions. Otherwise don't animate.
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
   `display: none` list next to `.bw-laser`, `.bw-boom`, `.bw-assigned-flash` and `.bw-launch`
   (modifiers of `.bw-boom`, e.g. `.bw-revive` and `.bw-assigned`, inherit it and need no entry).
   `.bw-supernova` is the exception: it keeps a static core (`::before` at `opacity: 1`) and hides
   only its ring and sparks, and JS shortens its lifetime to a brief flash. ChatPanel needs no entry:
   it skips its `opening`/`closing` presences in JS, so it opens and closes at once. SettingsShutter
   needs no entry: under reduced motion it never enters `opening`/`closing`. Decrypt text
   also skips in JS (`useDecrypt` never plays); its reduced-motion entry hides `.bw-decrypt-glyphs`
   and shows the real text as a fallback. The wordmark flicker skips in JS too
   (`useWordmarkFlicker` never schedules one), and the base rule covers it: it is opacity only and
   rests at opacity 1, so it needs no `display: none` entry.
7. If a duration or delay is mirrored elsewhere (another CSS rule or a TS constant), state the
   pairing in the CSS comment and next to the constant.
8. Run the Checks.

## Rules

- Animate only `transform`, `opacity` and `background-position`. Exceptions: `box-shadow` for the
  state pulses (`bw-pulse`, `bw-pulse-needs`, `bw-pulse-done`) and `text-shadow` for one-shot glows
  like `bw-pushed-glow`. Static glows (e.g. `.bw-boom::after`, `.bw-grid-horizon`) are fine; they
  just don't animate. Never animate layout properties (width, height, top, left, margin). One
  exception: `.bw-chat` transitions `width` on open/close only (the panel is part of the layout and
  never overlays); content inside is clipped and fixed-width, animating only `transform`/`opacity`;
  no transition while resizing.
- Another exception: the dialog open wipe (`animate-scan-wipe`) animates the inner panel's
  `clip-path`, polygon to polygon with the same 6 points, for 150ms on mount. Closing is instant
  (Radix unmounts), and the base rule covers reduced motion (the resting state is the full chamfer).
- Route wipe (`router.tsx`, `route-transition.ts`, `Inbox.tsx`): a View Transition that animates
  `clip-path` (`bw-route-wipe`, `inset`, 150ms) on `::view-transition-new(bw-route)` only; the old
  page stays underneath. The `root` and `bw-inbox` pseudos snap (old hidden), so the TopBar, chat
  and inbox don't wipe. Every pseudo needs `mix-blend-mode: normal` to override the UA
  `plus-lighter`, or the opaque snapshots brighten. Driven by TanStack's
  `defaultViewTransition.types` → `routeTransitionTypes`, it plays only when `routeViewKey` (the
  first path segment) changes and neither path is a Settings path (`isSettingsPath`), and is gated on `:active-view-transition-type` support
  (`supportsRouteTransition`) so other browsers get no untyped crossfade. Reduced motion returns
  `false` in JS, with a `::view-transition-*(*)` backstop in the base reduced-motion rule. No glow,
  no JS timer. Never call `document.startViewTransition` elsewhere. A new top-level route needs its
  own first segment to get the wipe.
- Colors come from tokens only: `var(--cyan)`, `--st-*`, `--grid-*`, `color-mix(...)`. No raw hex in
  keyframes or effect classes.
- Glow is dark only. Every glowing effect needs a light override.
- Reduced motion: never leave a frozen one-shot visible.
- Paired timings. Change both sides together and document the pairing:
  - Boom period = 2 × pulse period (3.2s/2.8s vs 1.6s/1.4s); boom delay = `--pulse-delay`.
  - `--animate-pulse-running` 1.6s ↔ `PULSE_RUNNING_S`, `--animate-pulse-needs` 1.4s ↔
    `PULSE_NEEDS_S`, `--animate-pulse-done` 2.4s ↔ `PULSE_DONE_S` (all in `agent-dots.ts`).
  - JS timeouts that mirror a CSS duration and drop the element (reduced motion turns the
    animation off, so no `animationend`): `.bw-launch` 900ms ↔ `LAUNCH_MS` in
    `use-archive-launches.ts`; `.bw-revive` 1.2s ↔ `REVIVE_MS` (1200) in `use-resume-bursts.ts`;
    `.bw-assigned`/`.bw-assigned-flash` 2.4s ↔ `ASSIGNED_BOOM_MS` (2400) in `count-boom.ts`;
    `.bw-supernova` 1.2s ↔ `SUPERNOVA_MS` (1200), its reduced-motion flash ↔ `SUPERNOVA_FLASH_MS`
    (300) and its 80ms stagger (`--supernova-delay`) ↔ `SUPERNOVA_STAGGER_MS`, all in `agent-dots.ts`;
    `.bw-chat` 180ms ↔ `CHAT_PANEL_MS` (180) in `chat.ts`, with the JS fallback at
    `CHAT_PANEL_FALLBACK_MS` (it settles the presence, since `transitionend` may not come);
    `.bw-shutter` 200ms ↔ `SHUTTER_MS` (200) in `settings-shutter.ts`, with the JS fallback at
    `SHUTTER_FALLBACK_MS` (it settles the presence and releases a held open).
  - `DECRYPT_MS` (300) in `decrypt.ts` is JS only (an rAF loop); no CSS mirrors it.
  - `STREAM_*` in `chat-stream.ts` are JS only (an rAF loop); no CSS mirrors them.
  - `.bw-wordmark-flicker` 700ms ↔ `WORDMARK_FLICKER_MS` (700) in `wordmark-flicker.ts`. No drop
    timeout: replay is a `key` remount, and `steps(1, end) both` ends at opacity 1.
- Booms: `.bw-boom` modifiers set `--boom-color`, `--boom-size` and `--boom-strength` (bloom
  opacity, 22% by default; `.bw-assigned` uses 55%). A large boom must sit inside a
  `pointer-events-none absolute inset-0 overflow-hidden` layer, never directly in a scroll container,
  or it adds scrollable overflow (GridAgents' boom layer, Home's pill row).
- Retrigger a one-shot by changing its React `key` (a counter or timestamp) so it remounts, as in
  `GridAgents.tsx` (`<span key={lasers} className="bw-laser" />`), `Backlog.tsx`
  (`<span key={note.at} className="animate-pushed-glow">`) and the `GridAgents.tsx` revive booms
  (``key={`revive:${taskId}:${count}`}``, `use-resume-bursts.ts`) and supernovas
  (``key={`supernova:${taskId}:${batch}`}``, `use-supernovas.ts`). Never toggle classes with timers.
  A resume booms cyan; if the request fails, `bump` raises `count` and sets tone `failed`, so the new
  key remounts the boom red (`.bw-revive-failed`, `--st-failed`) instead of recolouring one still
  playing. Prefix one-shot keys (`revive:`) when they share a container with keyed looping elements
  (`.bw-boom`, keyed by `dot.key`), so the keys never collide. Effects fired by a tasks change (lasers,
  supernovas) treat the first tasks snapshot as a seed only, so a reload never fires them.
- Decrypt text (`DecryptText.tsx`, `use-decrypt.ts`, `decrypt.ts`): a one-shot glyph scramble that
  settles left to right in `DECRYPT_MS`. `useDecrypt(text, trigger)` plays on mount when the trigger
  is non-null and again on each change to a non-null value. Pass a stable trigger (an id, or a
  counter bumped during render), never something that changes on every render. The real text stays
  in flow at `opacity: 0` and sets the width; the glyphs are an `aria-hidden` absolute overlay that
  inherits typography, including `text-transform`, colour and glow. No `aria-label`: it is not
  allowed on a generic `<span>`, and the real text node already serves screen readers. Share one
  hook's frame across stacked copies or split spans via `DecryptGlyphs`. Uses: the wordmark (once
  per app load, one frame split across `black`/`wall`), the RunningHeadline number on count change
  (one frame in both `.bw-running-base` and `.bw-running-hot`) and the TaskHeader title
  (`trigger={task.id}`).
- Chat stream (`ChatPanel.tsx`, `use-chat-stream.ts`, `chat-stream.ts`): a streamed chat reply
  reveals word by word, its newest `STREAM_TAIL_CHARS` letters and digits showing glyphs. It is a
  catch-up reveal: at least `STREAM_CHARS_PER_MS`, fast enough to clear any backlog within
  `STREAM_CATCHUP_MS`, frames at most every `STREAM_TICK_MS`, and it follows a target that keeps
  growing. `STREAM_GLYPHS` is markdown-safe (no `\ < > /`), and only `\p{L}\p{N}` swap, so the
  markdown keeps its shape; the last frame is exactly the text. JS only: no CSS, no glow. The draft
  bubble is `aria-hidden`; a revealing reply keeps its real `<Markdown>` in place as `sr-only` with
  an `aria-hidden` glyph copy beside it, so the log announces it once, and its action cards wait
  until it is all out. The final reply picks up where its draft stopped (`commonPrefixLength`);
  history and a draft already streaming on load show at once. Reduced motion never scrambles: the
  text shows as it arrives.
- Wordmark flicker (`Wordmark.tsx`, `use-wordmark-flicker.ts`, `wordmark-flicker.ts`): a one-shot
  700ms opacity stutter of icon and text, like a failing neon tube. `useWordmarkFlicker` returns a
  counter that a `setTimeout` bumps after a fresh random 30–100s gap (`flickerDelayMs`,
  `WORDMARK_FLICKER_MIN_MS`/`WORDMARK_FLICKER_MAX_MS`); the wordmark span is keyed on it so the
  animation replays. The counter starts at 0, so first mount never flickers. Cleanup clears the
  pending timer, so StrictMode's effect replay is safe. Opacity only, so no light override.
  Reduced motion is read on mount and never schedules one. It is decoration, not state: keep it
  rare, subtle and confined to the wordmark.
- Settings shutter (`SettingsShutter.tsx`, `settings-shutter.ts`): Settings is an overlay rendered
  by Root over the outlet column (never the TopBar or the chat), moving by `transform` only and
  clipped by an `overflow-clip` wrapper. The path drives presence; a `useBlocker` only holds an
  animated in-app open until the panel covers the page, then the URL commits unseen. Leaving
  Settings commits at once and the panel slides up over the new page, already mounted beneath.
  Transitions, not keyframes, so a reversal mid-slide is smooth. Section switches and first load
  don't animate. The bottom-edge cyan scanline shows only while moving, without glow in light. Any
  future route transition must skip navigations into or out of Settings (`isSettingsPath`).
- Mount-only animations follow `animate-bar-grow` (Stats.tsx: `origin-bottom animate-bar-grow`):
  fill mode `both`, set `transform-origin`, and don't animate later value changes.
- GridBackdrop:
  - Its parent is `relative` (Stats adds `isolate overflow-hidden`) and does not scroll. Scrolling
    content lives in a `relative z-10` sibling.
  - Centred content stays within the ~520px faded column (`calc(50% ± 260px)`, Stats uses
    `max-w-[520px]`) unless `fade={false}`.
  - Never put it behind a task view, Settings or modals.
  - The only JS is the pointer spotlight's `--mx`/`--my`, and RunningHeadline's own `--mx`/`--my`
    and `data-hover` for its local hover glow.
- Neon and motion mark state only (`blackwall-design` § Color semantics / Rules). GridBackdrop, Stats,
  the wordmark flicker, the route wipe and the Settings shutter scanline are the only sanctioned
  decorative exceptions.
- When a motion pattern, token or pairing changes, update this skill in the same commit.

## Checks

- `pnpm typecheck` and `pnpm lint`.
- In the browser, check both themes (`T`) and the OS reduced-motion setting: loops stop, one-shots
  never stick.
- After changing a timing, grep for the paired value (e.g. `rg -n "2.4s|PULSE_DONE_S" apps/web/src`).

## Changing this skill

When a motion pattern, token or pairing changes, update this skill in the same commit so it never
contradicts the code.
