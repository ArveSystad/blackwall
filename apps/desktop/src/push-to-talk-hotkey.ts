// Turns the system-wide keyboard hook's raw events into hold-to-talk edges.
import { VOICE_HOTKEY_CODES, type VoiceHotkey } from "@blackwall/shared";

/** `UiohookKey` name of each hold-to-talk `KeyboardEvent.code`: `KeyA` is `A`, `Digit1` is `1`. */
export const UIOHOOK_KEY_NAME: Readonly<Record<string, string>> = Object.fromEntries(
  VOICE_HOTKEY_CODES.map((code) => [code, code.replace(/^Key|^Digit/, "")]),
);

/** `UiohookKey` names of each modifier, left and right. */
const MODIFIER_KEY_NAMES = {
  ctrl: ["Ctrl", "CtrlRight"],
  alt: ["Alt", "AltRight"],
  shift: ["Shift", "ShiftRight"],
  meta: ["Meta", "MetaRight"],
} as const;

/** The fields of a uiohook keyboard event the tracker reads. */
export interface HookKeyEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type PushToTalkEdge = "down" | "up";

/** True when both are off or both are the same chord. */
export function sameHotkey(a: VoiceHotkey | null, b: VoiceHotkey | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

/**
 * Tracks whether the hold-to-talk key is held. `keycodes` is uiohook's
 * `UiohookKey` table (injected so tests need no native module). `emit` gets
 * `down` when the chord is pressed and `up` when its key or one of its
 * modifiers is released; key repeat is dropped. Changing or clearing the key
 * mid-hold emits `up` first.
 */
export function createHotkeyTracker({
  keycodes,
  emit,
}: {
  keycodes: Readonly<Record<string, number>>;
  emit: (edge: PushToTalkEdge) => void;
}) {
  let hotkey: VoiceHotkey | null = null;
  let held = false;

  const keycodeOf = (name: string | undefined) => (name === undefined ? undefined : keycodes[name]);

  function releaseKeycodes(current: VoiceHotkey): Set<number> {
    const codes = new Set<number>();
    const main = keycodeOf(UIOHOOK_KEY_NAME[current.code]);
    if (main !== undefined) codes.add(main);
    for (const modifier of ["ctrl", "alt", "shift", "meta"] as const) {
      if (!current[modifier]) continue;
      for (const name of MODIFIER_KEY_NAMES[modifier]) {
        const code = keycodeOf(name);
        if (code !== undefined) codes.add(code);
      }
    }
    return codes;
  }

  return {
    set(next: VoiceHotkey | null): void {
      if (sameHotkey(next, hotkey)) return;
      if (held) {
        held = false;
        emit("up");
      }
      hotkey = next;
    },

    keydown(event: HookKeyEvent): void {
      if (!hotkey || held) return;
      if (event.keycode !== keycodeOf(UIOHOOK_KEY_NAME[hotkey.code])) return;
      if (
        event.ctrlKey !== hotkey.ctrl ||
        event.altKey !== hotkey.alt ||
        event.shiftKey !== hotkey.shift ||
        event.metaKey !== hotkey.meta
      ) {
        return;
      }
      held = true;
      emit("down");
    },

    keyup(event: HookKeyEvent): void {
      if (!hotkey || !held || !releaseKeycodes(hotkey).has(event.keycode)) return;
      held = false;
      emit("up");
    },
  };
}
