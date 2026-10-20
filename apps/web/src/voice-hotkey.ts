import { VOICE_HOTKEY_CODES, type VoiceHotkey } from "@blackwall/shared";

const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "OS"]);
const CODES = new Set<string>(VOICE_HOTKEY_CODES);

type KeyFields = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
>;

/**
 * The chord a key press makes, or null for a lone modifier or a key outside
 * {@link VOICE_HOTKEY_CODES}. Not validated: run `voiceHotkeySchema` on it.
 */
export function hotkeyFromEvent(event: KeyFields): VoiceHotkey | null {
  if (MODIFIER_KEYS.has(event.key) || !CODES.has(event.code)) return null;
  return {
    code: event.code,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/** True when a key press is exactly `hotkey`: its key with the same modifiers. */
export function matchesHotkeyDown(event: KeyFields, hotkey: VoiceHotkey): boolean {
  return (
    event.code === hotkey.code &&
    event.ctrlKey === hotkey.ctrl &&
    event.altKey === hotkey.alt &&
    event.shiftKey === hotkey.shift &&
    event.metaKey === hotkey.meta
  );
}

/** True when a key release ends a hold of `hotkey`: its key or one of its modifiers. */
export function endsHotkey(
  event: Pick<KeyboardEvent, "key" | "code">,
  hotkey: VoiceHotkey,
): boolean {
  if (event.code === hotkey.code) return true;
  return (
    (hotkey.ctrl && event.key === "Control") ||
    (hotkey.alt && (event.key === "Alt" || event.key === "AltGraph")) ||
    (hotkey.shift && event.key === "Shift") ||
    (hotkey.meta && (event.key === "Meta" || event.key === "OS"))
  );
}

/**
 * True when a key press would type a character into a text field: a
 * single-character key from an Alt/Option or AltGr chord that isn't a plain
 * letter, digit or space. Ctrl- and Meta-only chords and F-keys never type.
 */
export function hotkeyTypesText(event: KeyFields): boolean {
  if (event.key.length !== 1) return false;
  if (event.metaKey) return false;
  if (!event.altKey) return false;
  return !/^[a-z0-9 ]$/i.test(event.key);
}

/** `hotkey` in `aria-keyshortcuts` form, e.g. "Control+Alt+Space". */
export function ariaKeyShortcuts(hotkey: VoiceHotkey): string {
  return [
    hotkey.ctrl && "Control",
    hotkey.alt && "Alt",
    hotkey.shift && "Shift",
    hotkey.meta && "Meta",
    hotkey.code.replace(/^Key|^Digit/, ""),
  ]
    .filter(Boolean)
    .join("+");
}

/** Whether the desktop shell's system-wide hold-to-talk hook runs, and why not. */
export interface PttStatus {
  active: boolean;
  reason: string | null;
}

/** What the desktop shell's preload (`apps/desktop/src/preload.cts`) exposes. */
export interface DesktopBridge {
  setPushToTalkHotkey(hotkey: VoiceHotkey | null): Promise<PttStatus>;
  getPushToTalkStatus(): Promise<PttStatus>;
  onPushToTalkStatus(callback: (status: PttStatus) => void): () => void;
  onPushToTalk(callback: (edge: "down" | "up") => void): () => void;
}

declare global {
  interface Window {
    blackwallDesktop?: DesktopBridge;
  }
}

/** The desktop shell's bridge, or undefined in a browser. */
export function desktopBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.blackwallDesktop;
}
