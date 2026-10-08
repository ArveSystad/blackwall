---
id: task-025
title: Dark by default, with a global dark/light toggle and hotkey
status: backlog
depends_on: []
---

## Goal
Dark is blackwall's theme, full stop: the app must start in dark mode regardless of the OS setting.
Light is opt-in only, via a button in the top-left header next to the Settings button and a
single-key shortcut, usable from anywhere in the app. Today the theme follows the OS
(`prefers-color-scheme`), so anyone with a light OS gets light by default; that has to go.

## Current state
- `apps/web/src/styles.css` defines dark tokens on `:root` and overrides them for light inside
  `@media (prefers-color-scheme: light) { :root { … } }`. Nothing else switches the theme.
- The top-left header lives in `apps/web/src/components/Inbox.tsx` (`Inbox`, around the
  `<Link to="/settings" aria-label="Settings">` gear button). It is rendered by the two-pane layout in
  `apps/web/src/router.tsx`.
- The Settings screen (`apps/web/src/routes/Settings.tsx`) replaces both panes and has its own left
  nav header, so the Inbox header is not visible there.
- Keyboard helpers are in `apps/web/src/keyboard.ts` (`isTypingTarget`, `isPlainKey`, `isModKey`,
  `modKeyLabel`). Global shortcuts are registered with `window.addEventListener("keydown", …)` in a
  `useEffect` (see `Inbox.tsx` for `/`).

## Behaviour
- **Dark is always the default.** The OS `prefers-color-scheme` is ignored entirely; there is no
  "system" mode. Theme is either `dark` (default) or `light`.
- The button and hotkey flip dark ↔ light.
- The choice is a per-browser convenience: store it in `localStorage` (key `blackwall.theme`), wrapped
  in try/catch. Missing, unknown or unreadable values mean dark. No server setting.
- Apply a stored `light` before first paint to avoid a dark→light flash: a tiny inline script in
  `apps/web/index.html` reads the key and sets `data-theme="light"` on `<html>`. Without it the page
  renders dark.
- **Hotkey: `T`** (plain key, no modifiers). It must not fire while focus is in a text field
  (`isTypingTarget`) or when a modifier is held (`isPlainKey`), matching the keyboard model in the
  `blackwall-design` skill. `T` is not used by any existing or planned shortcut (J/K, Enter, G N, N,
  /, ⌘↵, F, I, O, A, R, P, Esc, ?).

## Changes
1. **`apps/web/src/styles.css`**: remove the `@media (prefers-color-scheme: light)` wrapper and put the
   light tokens under `:root[data-theme="light"]` only (with `color-scheme: light`). `:root` stays dark
   with `color-scheme: dark`. Update the file header comment ("Dark is the default; light applies only
   when the user picks it"). Grep the rest of `apps/web/src` for other `prefers-color-scheme` uses and
   remove them too. Glow stays dark-only, as today.
2. **`apps/web/index.html`**: inline pre-paint script that sets `data-theme="light"` on
   `document.documentElement` only when `localStorage` holds `light`, inside try/catch.
3. **New `apps/web/src/theme.ts`**: `readTheme()` (dark unless stored `light`), `setTheme(theme)` and
   `toggleTheme()`. Unit-tested (`theme.test.ts`) for: default dark with empty storage, default dark
   even when `matchMedia('(prefers-color-scheme: light)')` matches, toggle dark → light → dark,
   garbage value → dark, storage throwing → dark.
4. **New `apps/web/src/components/ThemeToggle.tsx`**: ghost icon `Button` (`size="icon"`, same as the
   gear) showing a sun icon in dark theme and a moon icon in light theme (add both to
   `components/icons.tsx` in the existing icon style). `aria-label` says what it will do
   ("Switch to light theme" / "Switch to dark theme"); tooltip/title includes the `T` shortcut
   (`Kbd` hint style). Re-renders when the theme changes (small hook, e.g. `useTheme()`).
5. **Global hotkey**: register `T` once at app level (e.g. in the root route component in
   `router.tsx` or a `useThemeHotkey()` called from it), not inside `Inbox`, so it works on every
   route including Settings.
6. **Placement**:
   - `Inbox.tsx` header: put `ThemeToggle` immediately left of the Settings gear.
   - `Settings.tsx` left nav header: add the same `ThemeToggle` in the same top-left position so it is
     reachable on that screen too.
7. **Docs**: in `.claude/skills/blackwall-design/SKILL.md` add `T toggle theme` to the Keyboard line
   and state that dark is always the default and light is opt-in via `data-theme="light"` (never the
   OS). Update `README.md` / `docs/design/README.md` wherever they say light follows the OS.

## Acceptance criteria
- Clicking the button or pressing `T` flips dark ↔ light instantly on Inbox, Task view and Settings.
- Pressing `T` inside the filter input or any other text field types a "t" and does not toggle.
- A fresh browser (no stored choice) opens in dark, even when the OS is set to light.
- A chosen light theme survives a reload with no dark flash; choosing dark again also persists.
- No `prefers-color-scheme` remains in `apps/web/src`.
- Both themes still look right (check against `docs/design/*Light.dc.html`), focus ring visible on the
  button, `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Refs
`.claude/skills/blackwall-design/SKILL.md` (Keyboard, themes), `docs/design/README.md`,
`apps/web/src/styles.css`, `apps/web/src/components/Inbox.tsx`, `apps/web/src/routes/Settings.tsx`,
`apps/web/src/keyboard.ts`
