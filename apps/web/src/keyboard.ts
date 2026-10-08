/** True when a key press goes to a text field, where global shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
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
