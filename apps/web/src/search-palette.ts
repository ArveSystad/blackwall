import { useSyncExternalStore } from "react";
import { useWindowKeydown } from "./keyboard";
import { searchShortcut } from "./search";

/** Whether the search palette is open; shared by the top bar's button and the hotkey. */
const listeners = new Set<() => void>();
let open = false;

function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function searchOpen(): boolean {
  return open;
}

export function openSearch(): void {
  setOpen(true);
}

export function closeSearch(): void {
  setOpen(false);
}

export function toggleSearch(): void {
  setOpen(!open);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the palette is open, re-rendering when it changes. */
export function useSearchOpen(): boolean {
  return useSyncExternalStore(subscribe, searchOpen, () => false);
}

/**
 * The global ⌘K / Ctrl+K shortcut. Register once at app level. It works from text fields too,
 * like ⌘S, but not while another dialog is open, so modals never stack.
 */
export function useSearchHotkey(): void {
  useWindowKeydown((event) => {
    if (searchShortcut(event) !== "toggle") return;
    // Keeps the browser's own Ctrl+K (address bar search) away even when nothing opens.
    event.preventDefault();
    if (event.repeat) return;
    if (!open && document.querySelector("[role=dialog]")) return;
    toggleSearch();
  });
}
