import { useEffect, useRef } from "react";

/**
 * True when a key press goes to a text field or an open/focused select menu, where global shortcuts
 * must not fire (menus use letter keys for type-to-find).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.closest("[role=combobox],[role=listbox]") !== null;
}

/** A plain key press: no Ctrl, Meta or Alt held. */
export function isPlainKey(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** True on macOS, where shortcuts use ⌘ instead of Ctrl. */
export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** ⌘ or Ctrl held (without Alt), as shortcuts like ⌘S expect. */
export function isModKey(event: KeyboardEvent): boolean {
  return (isMac() ? event.metaKey : event.ctrlKey) && !event.altKey;
}

/** Label for a ⌘/Ctrl shortcut, e.g. `modKeyLabel("S")` is "⌘S" on macOS and "Ctrl S" elsewhere. */
export function modKeyLabel(key: string): string {
  return isMac() ? `⌘${key}` : `Ctrl ${key}`;
}

/** Calls the latest `handler` for every key press on the window while `enabled`. */
export function useWindowKeydown(handler: (event: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      latest.current(event);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** A plain Escape no other handler claimed and not aimed at a text field or select menu. */
export function isEscapeToLeave(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.key === "Escape" &&
    isPlainKey(event) &&
    !isTypingTarget(event.target)
  );
}

/** Calls the latest `onEscape` when Escape should leave the page: no dialog open, no field focused. */
export function useEscapeTo(onEscape: () => void, enabled = true): void {
  useWindowKeydown((event) => {
    if (!isEscapeToLeave(event) || document.querySelector("[role=dialog]")) return;
    onEscape();
  }, enabled);
}
