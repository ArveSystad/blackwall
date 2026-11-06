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
   `.bw-revive`/`.bw-revive-failed`, `.bw-supernova` and `.bw-launch` for GridAgents.tsx, the repo
   skyline's `.bw-tower*`, `.bw-tether` and `animate-beacon-blink` for GridSkyline.tsx, `.bw-assigned`/
   `.bw-assigned-flash` for CountPill.tsx, `.bw-sign*`/`.bw-running*` for RunningSign.tsx, `.bw-chat`/
   `.bw-chat-content` for ChatPanel.tsx, `.bw-shutter` for SettingsShutter.tsx, `.bw-decrypt*` for DecryptText.tsx,
   `.bw-status-sweep` for TaskCard.tsx, `.bw-tab-flash` for TaskView.tsx (the Agent output tab),
   `.bw-wordmark-flicker` for Wordmark.tsx, `.bw-shot*`/`.bw-shoot` and the passing ships' `.bw-ship*` for GridShots.tsx,
   `.bw-star*` (`.bw-star-layer`, `.bw-star-slot`, `.bw-star`, `.bw-star-arrive`) for GridStars.tsx,
   `.bw-grid-flare`/`.bw-grid[data-kick]` for GridBackdrop.tsx's shot flare and shake, `bw-scan-wipe`/`bw-scan-unwipe`/`bw-scan-hold` (`--animate-scan-wipe`/`-unwipe`/`-hold`) for ui/dialog.tsx,
   `.bw-window` for GridLayout.tsx's task/Backlog window and the New task dialog (NewTaskModal.tsx via
   `DialogContent motion="flicker"`)), and `bw-route-wipe` with the
   `::view-transition-*(bw-route|bw-inbox|root)` rules for the route wipe (router.tsx, Inbox.tsx,
   route-transition.ts). `animate-arrive` also slides in GrillPanel.tsx answer rows that arrive
   while their card is open (tracked during render; loaded answers never animate).
2. `.claude/skills/blackwall-design/SKILL.md` § Color semantics / Rules: the state-only rule and its
   seven decorative exceptions (GridBackdrop, Stats, the wordmark flicker, the route wipe, the
   Settings shutter scanline, the Home grid shot, today's stars).
3. Reference code: `apps/web/src/components/GridBackdrop.tsx`, `apps/web/src/components/GridAgents.tsx`,
   `apps/web/src/components/RunningSign.tsx`, `apps/web/src/routes/Stats.tsx`, `apps/web/src/routes/Backlog.tsx`, `apps/web/src/agent-dots.ts`,
   `apps/web/src/skyline.ts`, `apps/web/src/components/GridSkyline.tsx`,
   `apps/web/src/components/use-archive-launches.ts`, `apps/web/src/components/use-resume-bursts.ts`,
   `apps/web/src/components/use-supernovas.ts`, `apps/web/src/components/use-status-sweeps.ts`,
   `apps/web/src/decrypt.ts`,
   `apps/web/src/components/use-decrypt.ts`, `apps/web/src/chat-stream.ts`,
   `apps/web/src/components/use-chat-stream.ts`, `apps/web/src/settings-shutter.ts`,
   `apps/web/src/components/SettingsShutter.tsx`, `apps/web/src/components/Wordmark.tsx`,
   `apps/web/src/wordmark-flicker.ts`, `apps/web/src/components/use-wordmark-flicker.ts`,
   `apps/web/src/shots.ts`, `apps/web/src/components/use-shots.ts`,
   `apps/web/src/components/GridShots.tsx`, `apps/web/src/ships.ts`,
   `apps/web/src/components/GridStars.tsx`, `apps/web/src/grid-stars.ts`,
   `apps/web/src/components/use-ships.ts`, `apps/web/src/components/Spaceship.tsx`,
   `apps/web/src/components/use-count-boom.ts` (detects the rise during render and keeps its timer in
   a `[boom]` effect, so StrictMode's effect replay can't strand it).

Code wins over this skill. Flag any conflict instead of silently picking one.

## Procedure

1. Confirm the motion marks state, or falls under the GridBackdrop/Stats/wordmark-flicker/route-wipe/
   shutter scanline/grid shot/today's stars exceptions. Otherwise don't animate.
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
   `display: none` list next to `.bw-laser`, `.bw-boom`, `.bw-assigned-flash`, `.bw-tab-flash`, `.bw-launch`,
   `.bw-status-sweep`, `.bw-ship` and `.bw-ship-boom-core`
   (modifiers of `.bw-boom`, e.g. `.bw-revive` and `.bw-assigned`, inherit it and need no entry).
   `.bw-supernova` is the exception: it keeps a static core (`::before` at `opacity: 1`) and hides
   only its ring and sparks, and JS shortens its lifetime to a brief flash. ChatPanel needs no entry:
   it skips its `opening`/`closing` presences in JS, so it opens and closes at once. SettingsShutter
   needs no entry: under reduced motion it never enters `opening`/`closing`. Decrypt text
   also skips in JS (`useDecrypt` never plays); its reduced-motion entry hides `.bw-decrypt-glyphs`
   and shows the real text as a fallback. The wordmark flicker skips in JS too
   (`useWordmarkFlicker` never schedules one), and the base rule covers it: it is opacity only and
   rests at opacity 1, so it needs no `display: none` entry. The skyline's favourite beacon
   (`animate-beacon-blink`) is the same: opacity only, resting lit, so it stays lit under reduced
   motion with no entry.
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
- Another exception: the dialog scan wipe animates the inner panel's `clip-path`, polygon to
  polygon with the same 6 points. Opening, `animate-scan-wipe` runs on the panel for 150ms. Closing,
  `animate-scan-unwipe` runs on the panel for 120ms while `animate-scan-hold` (120ms, must match) on
  `Content` and the `Overlay` keeps Radix Presence mounted until the unwipe ends. With
  `motion="flicker"`, `.bw-window` goes on `Content` (not the panel) and the panel's wipe is dropped,
  so the dialog opens with the 360ms `.bw-window` opacity flicker; its close still unwipes, because
  the utility `data-[state=closed]:animate-scan-hold` overrides the components-layer `.bw-window`.
  The base reduced-motion rule covers all of these: the resting state is the full chamfer at opacity
  1, and the close is instant.
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
    `SHUTTER_FALLBACK_MS` (it settles the presence and releases a held open);
    `.bw-shot-mark` 1.5s (the longest part of a grid shot) ↔ `SHOT_MS` (1500) in `shots.ts`.
  - The recoil cursor (`.bw-shoot[data-recoil]`) ↔ `RECOIL_MS` (80) in `shots.ts`.
  - `.bw-star-arrive` 1.2s delay ↔ `STAR_ARRIVE_DELAY_MS` (= `SUPERNOVA_MS`) in `grid-stars.ts`, so
    a new star fades in (600ms) once the done supernova ends. No drop timeout: fill `both`, ends at 1.
  - Grid shot sparks: `SPARK_*` ranges in `shots.ts` feed `.bw-shot-spark` (360ms) through inline
    `--spark-*` vars; `AUTO_FIRE_MS` (110) is JS only (an rAF loop). `makeSparks` takes optional
    `SparkRanges` (default `SHOT_SPARKS`); `.bw-shot-spark`'s colour is `--spark-color` (cyan by default).
  - Grid ships (`ships.ts`): `.bw-ship-boom::before` 1.1s (the longest part of a ship explosion) ↔
    `SHIP_BOOM_MS` (1100); `SHIP_DEBRIS` (count, reach, length, up to 80ms delay) ↔ the 700ms
    `.bw-ship-boom .bw-shot-spark` override; each ship's `durationMs` ↔ its inline `--ship-duration`
    (`bw-ship-fly`), after which `useShips` drops it off-screen; the spawn gap (`SHIP_GAP_MIN_MS`..
    `SHIP_GAP_MAX_MS`) is JS only. `useShips`' `strike` and `registerBody` must stay stable (`[]` deps,
    refs only): GridShots' listener effect depends on them and its cleanup ends a held trigger.
  - `.bw-grid-flare` 260ms and the `bw-grid-kick-a`/`-b` 120ms shake have no JS mirror: the flare
    remounts by `key` and rests transparent; the shake retriggers by alternating `data-kick` between
    `a` and `b` (two identical keyframes) and ends untransformed. Under reduced motion nothing fires.
  - `.bw-status-sweep` 700ms has no JS mirror: the inbox drops it on `animationend`, and under
    reduced motion it is `display: none`, so it never shows.
  - `.bw-tab-flash` 1.2s has no JS mirror: replay is a `key` remount and it rests at opacity 0
    (`bw-assigned-flash` keyframe, fill `both`); under reduced motion it is `display: none`.
  - `DECRYPT_MS` (300) in `decrypt.ts` is JS only (an rAF loop); no CSS mirrors it.
  - `STREAM_*` in `chat-stream.ts` are JS only (an rAF loop); no CSS mirrors them.
  - `.bw-wordmark-flicker` 700ms ↔ `WORDMARK_FLICKER_MS` (700) in `wordmark-flicker.ts`. No drop
    timeout: replay is a `key` remount, and `steps(1, end) both` ends at opacity 1.
  - Paired positions: `HORIZON_Y` (0.58) in `agent-dots.ts` ↔ the 58% in `.bw-grid-horizon`,
    `.bw-grid-glow` and `.bw-grid-floor`. The skyline's towers stand on it (`skyline.ts`).
  - `--animate-scan-hold` 120ms ↔ `--animate-scan-unwipe` 120ms (both in `styles.css`): the hold
    keeps the dialog's `Content` and `Overlay` mounted while the panel unwipes, so the two must
    change together.
- Booms: `.bw-boom` modifiers set `--boom-color`, `--boom-size` and `--boom-strength` (bloom
  opacity, 22% by default; `.bw-assigned` uses 55%). A large boom must sit inside a
  `pointer-events-none absolute inset-0 overflow-hidden` layer, never directly in a scroll container,
  or it adds scrollable overflow (GridAgents' boom layer, Home's pill row). The skyline's tether
  svg (`GridTethers`) must stay the first child of GridAgents' boom layer, which keeps no z-index,
  so tethers paint under every boom and dot.
- Retrigger a one-shot by changing its React `key` (a counter or timestamp) so it remounts, as in
  `GridAgents.tsx` (`<span key={lasers} className="bw-laser" />`), `Backlog.tsx`
  (`<span key={note.at} className="animate-pushed-glow">`) and the `GridAgents.tsx` revive booms
  (``key={`revive:${taskId}:${count}`}``, `use-resume-bursts.ts`) and supernovas
  (``key={`supernova:${taskId}:${batch}`}``, `use-supernovas.ts`), and the inbox status sweep
  (``key={`sweep:${sweep}`}``, `use-status-sweeps.ts`), which is dropped on `animationend` or when
  its card is hidden, not on a timer, and the Agent output tab flash
  (``key={`flash:${outputFlash}`}``, `TaskView.tsx`), bumped during render when `tabOnSignal`
  returns `flash`. Never toggle classes with timers. The one sanctioned exception is the grid
  shot's recoil cursor: a cursor can't be animated, so GridShots sets `data-recoil` on Home's pane
  and a `RECOIL_MS` timeout clears it. Its `data-firing` is pointer-driven (set on an accepted
  press, cleared on release, leave, blur or unmount), not timer-driven, and turns text selection
  off while the trigger is held.
  A resume booms cyan; if the request fails, `bump` raises `count` and sets tone `failed`, so the new
  key remounts the boom red (`.bw-revive-failed`, `--st-failed`) instead of recolouring one still
  playing. Prefix one-shot keys (`revive:`) when they share a container with keyed looping elements
  (`.bw-boom`, keyed by `dot.key`), so the keys never collide. Effects fired by a tasks change (lasers,
  supernovas, status sweeps) treat the first tasks snapshot as a seed only, so a reload never fires them.
  Today's stars (`GridStars.tsx`, `nextArrivals`) follow the same rule, but seed from the first
  snapshot where the done-times query has data, not the first render, so stars that load late
  never count as new.
- Decrypt text (`DecryptText.tsx`, `use-decrypt.ts`, `decrypt.ts`): a one-shot glyph scramble that
  settles left to right in `DECRYPT_MS`. `useDecrypt(text, trigger)` plays on mount when the trigger
  is non-null and again on each change to a non-null value. Pass a stable trigger (an id, or a
  counter bumped during render), never something that changes on every render. The real text stays
  in flow at `opacity: 0` and sets the width; the glyphs are an `aria-hidden` absolute overlay that
  inherits typography, including `text-transform`, colour and glow. No `aria-label`: it is not
  allowed on a generic `<span>`, and the real text node already serves screen readers. Share one
  hook's frame across stacked copies or split spans via `DecryptGlyphs`. Uses: the wordmark (once
  per app load, one frame split across `black`/`wall`), the RunningSign numbers on count change
  (one hook per number, each frame in both `.bw-running-base` and `.bw-running-hot`) and the TaskHeader title
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
  - The only JS is the pointer spotlight's `--mx`/`--my`, the grid shot's flare (`.bw-grid-flare`,
    keyed per shot, at `--fx`/`--fy`) and shake (`data-kick`) from GridShots' bubbling `SHOT_EVENT`,
    and RunningSign's own `--mx`/`--my` and `data-hover` for its local hover glow. Under 3D
    transforms, take pointer coordinates from `offsetX`/`offsetY` on a target whose children are
    `pointer-events: none` (local, transform-inverted space), not `clientX - getBoundingClientRect()`
    (the projected box drifts).
  - `--grid-fade` can also drive a uniform `opacity` for a layer that straddles the fade ramp
    (`.bw-sign-layer` and `.bw-star-layer`, with `[data-full]` setting it to 1), so it dims evenly
    with the same ease.
- The running sign floats with `animate-sign-float` (`--animate-sign-float`, 7s, 0 → −4px); it rests
  at 0 under reduced motion, so it needs no `display: none` entry.
- Today's stars (`GridStars.tsx`): three nested opacities multiply, so none overrides another. The
  slot's `.bw-star-arrive` fades a new star in, `.bw-star` holds its static base `--star-opacity`,
  and the twinkle (`bw-star-twinkle`, opacity only, 1 → 0.45 → 1 over `--twinkle-duration`) runs on
  `.bw-star::before`. The base reduced-motion rule stops both the twinkle and the fade-in, so stars
  rest still at their own brightness and need no `display: none` entry. Glow (the core's
  `drop-shadow`) is dark only.
- Neon and motion mark state only (`blackwall-design` § Color semantics / Rules). GridBackdrop, Stats,
  the wordmark flicker, the route wipe, the Settings shutter scanline, the Home grid shot and today's
  stars are the only sanctioned decorative exceptions.
- When a motion pattern, token or pairing changes, update this skill in the same commit.

## Checks

- `pnpm typecheck` and `pnpm lint`.
- In the browser, check both themes (`T`) and the OS reduced-motion setting: loops stop, one-shots
  never stick.
- After changing a timing, grep for the paired value (e.g. `rg -n "2.4s|PULSE_DONE_S" apps/web/src`).

## Changing this skill

When a motion pattern, token or pairing changes, update this skill in the same commit so it never
contradicts the code.
