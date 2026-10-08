---
id: task-025
title: Global dark/light theme toggle with a hotkey
status: backlog
depends_on: []
---

## Goal
Let the user switch between dark and light theme from anywhere in the app, with a button in the
top-left header next to the Settings button and a single-key shortcut. Today the theme only follows
the OS (`prefers-color-scheme`), so a user who wants light while the OS is dark (or the reverse) has
no way to get it.

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
- Theme preference has three values internally: `system` (default, follows the OS), `dark`, `light`.
  The button and hotkey toggle between dark and light based on the theme currently showing: if the
  page shows dark, switch to light, and the reverse. The first toggle therefore moves off `system`.
- The choice is a per-browser convenience: store it in `localStorage` (key `blackwall.theme`), wrapped
  in try/catch so a blocked storage falls back to `system`. No server setting.
- Apply it before first paint to avoid a flash of the wrong theme: a tiny inline script in
  `apps/web/index.html` reads the key and sets `data-theme` on `<html>`.
- While on `system`, react to OS changes live (existing media query keeps doing this).
- **Hotkey: `T`** (plain key, no modifiers). It must not fire while focus is in a text field
  (`isTypingTarget`) or when a modifier is held (`isPlainKey`), matching the keyboard model in the
  `blackwall-design` skill. `T` is not used by any existing or planned shortcut (J/K, Enter, G N, N,
  /, ⌘↵, F, I, O, A, R, P, Esc, ?).

## Changes
1. **`apps/web/src/styles.css`**: make the light override apply in two cases, and let an explicit
   dark choice beat an OS light preference:
   ```css
   /* OS prefers light and the user has not forced dark */
   @media (prefers-color-scheme: light) {
     :root:not([data-theme="dark"]) { /* light tokens, color-scheme: light */ }
   }
   /* user forced light */
   :root[data-theme="light"] { /* same light tokens */ }
   ```
   Avoid duplicating the token block by hand if possible (e.g. one shared selector list
   `:root[data-theme="light"]` plus the media-guarded `:root:not([data-theme="dark"])`). Update the file
   header comment. Glow stays dark-only, as today.
2. **`apps/web/index.html`**: inline pre-paint script that sets `document.documentElement.dataset.theme`
   to `dark`/`light` from `localStorage`, inside try/catch.
3. **New `apps/web/src/theme.ts`**: `readThemePreference()`, `setThemePreference(pref)`,
   `effectiveTheme()` (resolves `system` with `matchMedia`) and `toggleTheme()`. Pure-ish and unit-tested
   (`theme.test.ts`) for: default `system`, toggling from system-dark → light, from light → dark,
   storage throwing.
4. **New `apps/web/src/components/ThemeToggle.tsx`**: ghost icon `Button` (`size="icon"`, same as the
   gear) showing a sun icon in dark theme and a moon icon in light theme (add both to
   `components/icons.tsx` in the existing icon style). `aria-label` says what it will do
   ("Switch to light theme" / "Switch to dark theme"); tooltip/title includes the `T` shortcut
   (`Kbd` hint style). Re-renders when the theme changes (small hook, e.g. `useTheme()`, that also
   listens to the OS media query while on `system`).
5. **Global hotkey**: register `T` once at app level (e.g. in the root route component in
   `router.tsx` or a `useThemeHotkey()` called from it), not inside `Inbox`, so it works on every
   route including Settings.
6. **Placement**:
   - `Inbox.tsx` header: put `ThemeToggle` immediately left of the Settings gear.
   - `Settings.tsx` left nav header: add the same `ThemeToggle` in the same top-left position so it is
     reachable on that screen too.
7. **`blackwall-design` skill** (`.claude/skills/blackwall-design/SKILL.md`): add `T toggle theme` to
   the Keyboard line and note under themes that the user can override the OS via `data-theme`.

## Acceptance criteria
- Clicking the button or pressing `T` flips dark ↔ light instantly on Inbox, Task view and Settings.
- Pressing `T` inside the filter input or any other text field types a "t" and does not toggle.
- The choice survives a reload with no flash of the other theme.
- With no stored choice, the app still follows the OS, including live OS changes.
- Both themes still look right (check against `docs/design/*Light.dc.html`), focus ring visible on the
  button, `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.

## Refs
`.claude/skills/blackwall-design/SKILL.md` (Keyboard, themes), `docs/design/README.md`,
`apps/web/src/styles.css`, `apps/web/src/components/Inbox.tsx`, `apps/web/src/routes/Settings.tsx`,
`apps/web/src/keyboard.ts`
