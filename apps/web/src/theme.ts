import { useEffect, useSyncExternalStore } from "react";
import { isPlainKey, isTypingTarget } from "./keyboard";

/**
 * Dark is blackwall's theme; light is opt-in per browser. The OS color-scheme preference is
 * ignored on purpose. The pre-paint script in index.html applies a stored `light` before React
 * loads, using the same storage key.
 */
export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "blackwall.theme";

const listeners = new Set<() => void>();
let current: Theme | undefined;

/** The stored theme: dark unless storage holds exactly `light`. Unreadable storage means dark. */
export function readTheme(): Theme {
  try {
    return globalThis.localStorage?.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The theme in effect for this page. */
export function currentTheme(): Theme {
  current ??= readTheme();
  return current;
}

/** Switch theme: applies it to <html>, remembers it in this browser and notifies `useTheme`. */
export function setTheme(theme: Theme): void {
  current = theme;
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage is a convenience; the theme still applies for this page.
  }
  if (typeof document !== "undefined") {
    if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  }
  for (const listener of listeners) listener();
}

/** Flip dark ↔ light and return the new theme. */
export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === "light" ? "dark" : "light";
  setTheme(next);
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current theme, re-rendering when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => "dark");
}

/** The global `T` shortcut. Register once at app level so it works on every route. */
export function useThemeHotkey(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || !isPlainKey(event) || isTypingTarget(event.target)) return;
      if (event.key.toLowerCase() !== "t") return;
      event.preventDefault();
      toggleTheme();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
