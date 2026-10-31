import { useEffect, useSyncExternalStore } from "react";
import { isPlainKey, isTypingTarget, useWindowKeydown } from "./keyboard";

/**
 * The theme follows the device's `prefers-color-scheme`, falling back to dark, and updates live
 * when the device switches. Toggling (the top bar button or `T`) picks a theme until the device
 * next switches; picking the device theme goes back to following it. A long press on the button
 * locks the current theme in this browser, so device switches leave it alone, and another long
 * press unlocks it. The pre-paint script in index.html applies a stored theme, or else the device
 * preference, before React loads, using the same storage key, and sets the `theme-color` meta tag
 * to match.
 */
export type Theme = "dark" | "light";

/** The theme chosen by the user. Missing means follow the device. */
export const THEME_STORAGE_KEY = "blackwall.theme";

/** `1` while the user has locked the theme against device switches. */
export const THEME_LOCK_STORAGE_KEY = "blackwall.themeLocked";

/**
 * The canvas colour per theme, matching `--bg-0` in styles.css. Published as `theme-color`: the
 * desktop title bar reads it, and browsers may tint their toolbar with it.
 */
export const THEME_COLORS: Record<Theme, string> = { dark: "#0a0918", light: "#f3f3f6" };

const LIGHT_QUERY = "(prefers-color-scheme: light)";

const listeners = new Set<() => void>();
let current: Theme | undefined;
let locked: boolean | undefined;

/** The device's theme: light when it prefers light, otherwise (or when unknown) dark. */
export function systemTheme(): Theme {
  try {
    return globalThis.matchMedia?.(LIGHT_QUERY).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The stored theme, or the device theme when none is stored or storage is unreadable. */
export function readTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the device theme.
  }
  return systemTheme();
}

/** The theme in effect for this page. */
export function currentTheme(): Theme {
  current ??= readTheme();
  return current;
}

/** Whether the user has locked the theme against device switches. */
export function isThemeLocked(): boolean {
  if (locked === undefined) {
    try {
      locked = globalThis.localStorage?.getItem(THEME_LOCK_STORAGE_KEY) === "1";
    } catch {
      locked = false;
    }
  }
  return locked;
}

function storeItem(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage is a convenience; the theme still applies for this page.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Apply a theme to <html> and the theme-color tag without storing it, and notify listeners. */
export function applyTheme(theme: Theme): void {
  current = theme;
  if (typeof document !== "undefined") {
    if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLORS[theme]);
  }
  notify();
}

/**
 * Switch theme. While locked the choice is stored as is; otherwise it is stored only when it
 * differs from the device theme, and picking the device theme goes back to following the device.
 */
export function setTheme(theme: Theme): void {
  storeItem(THEME_STORAGE_KEY, isThemeLocked() || theme !== systemTheme() ? theme : null);
  applyTheme(theme);
}

/** Flip dark ↔ light and return the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}

/**
 * Lock the current theme against device switches, or unlock it and follow the device again
 * straight away. Returns the new lock state.
 */
export function toggleThemeLock(): boolean {
  if (isThemeLocked()) {
    storeItem(THEME_LOCK_STORAGE_KEY, null);
    storeItem(THEME_STORAGE_KEY, null);
    locked = false;
    applyTheme(systemTheme());
    return false;
  }
  storeItem(THEME_LOCK_STORAGE_KEY, "1");
  storeItem(THEME_STORAGE_KEY, currentTheme());
  locked = true;
  notify();
  return true;
}

/** Follow the device theme again, dropping an unlocked choice. Does nothing while locked. */
export function syncToSystemTheme(): void {
  if (isThemeLocked()) return;
  storeItem(THEME_STORAGE_KEY, null);
  applyTheme(systemTheme());
}

/**
 * Follow device light/dark switches live. Returns the unsubscribe function; a no-op where the
 * browser can't report changes.
 */
export function watchSystemTheme(): () => void {
  let mql: MediaQueryList | undefined;
  try {
    mql = globalThis.matchMedia?.(LIGHT_QUERY);
  } catch {
    mql = undefined;
  }
  if (!mql || typeof mql.addEventListener !== "function") return () => {};
  const media = mql;
  const handler = () => syncToSystemTheme();
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

/** Subscribe to theme and lock changes. Returns the unsubscribe function. */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme, re-rendering when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => "dark");
}

/** Whether the theme is locked, re-rendering when that changes. */
export function useThemeLocked(): boolean {
  return useSyncExternalStore(subscribeTheme, isThemeLocked, () => false);
}

/** Follow device light/dark switches. Register once at app level. */
export function useSystemThemeSync(): void {
  useEffect(() => watchSystemTheme(), []);
}

/** The global `T` shortcut. Register once at app level so it works on every route. */
export function useThemeHotkey(): void {
  useWindowKeydown((event) => {
    if (event.repeat || !isPlainKey(event) || isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() !== "t") return;
    event.preventDefault();
    toggleTheme();
  });
}
