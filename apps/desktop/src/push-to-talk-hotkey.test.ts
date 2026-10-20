import { VOICE_HOTKEY_CODES } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  createHotkeyTracker,
  sameHotkey,
  UIOHOOK_KEY_NAME,
  type HookKeyEvent,
  type PushToTalkEdge,
} from "./push-to-talk-hotkey.js";

/** A slice of uiohook's `UiohookKey` table. */
const KEYCODES = {
  Space: 57,
  F9: 67,
  F10: 68,
  P: 25,
  Ctrl: 29,
  CtrlRight: 3613,
  Alt: 56,
  AltRight: 3640,
  Shift: 42,
  ShiftRight: 54,
  Meta: 3675,
  MetaRight: 3676,
};

const F9 = { code: "F9", ctrl: false, alt: false, shift: false, meta: false };
const CTRL_ALT_SPACE = { code: "Space", ctrl: true, alt: true, shift: false, meta: false };

function key(keycode: number, mods: Partial<HookKeyEvent> = {}): HookKeyEvent {
  return { keycode, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods };
}

function tracker() {
  const edges: PushToTalkEdge[] = [];
  const t = createHotkeyTracker({ keycodes: KEYCODES, emit: (edge) => edges.push(edge) });
  return { t, edges };
}

describe("createHotkeyTracker", () => {
  it("emits one down and one up per hold, dropping key repeat", () => {
    const { t, edges } = tracker();
    t.set(F9);
    t.keydown(key(KEYCODES.F9));
    t.keydown(key(KEYCODES.F9));
    t.keydown(key(KEYCODES.F9));
    t.keyup(key(KEYCODES.F9));
    t.keyup(key(KEYCODES.F9));
    expect(edges).toEqual(["down", "up"]);
  });

  it("does nothing without a hotkey or for other keys", () => {
    const { t, edges } = tracker();
    t.keydown(key(KEYCODES.F9));
    t.set(F9);
    t.keydown(key(KEYCODES.F10));
    t.keyup(key(KEYCODES.F10));
    expect(edges).toEqual([]);
  });

  it("needs exactly the hotkey's modifiers", () => {
    const { t, edges } = tracker();
    t.set(CTRL_ALT_SPACE);
    t.keydown(key(KEYCODES.Space, { ctrlKey: true }));
    t.keydown(key(KEYCODES.Space, { ctrlKey: true, altKey: true, shiftKey: true }));
    t.set(F9);
    t.keydown(key(KEYCODES.F9, { ctrlKey: true }));
    expect(edges).toEqual([]);
  });

  it("ends the hold when a required modifier is released", () => {
    const { t, edges } = tracker();
    t.set(CTRL_ALT_SPACE);
    t.keydown(key(KEYCODES.Space, { ctrlKey: true, altKey: true }));
    t.keyup(key(KEYCODES.Shift));
    expect(edges).toEqual(["down"]);
    t.keyup(key(KEYCODES.AltRight, { ctrlKey: true }));
    expect(edges).toEqual(["down", "up"]);
  });

  it("emits up when the hotkey changes or is cleared mid-hold", () => {
    const { t, edges } = tracker();
    t.set(F9);
    t.keydown(key(KEYCODES.F9));
    t.set(F9);
    expect(edges).toEqual(["down"]);
    t.set(CTRL_ALT_SPACE);
    expect(edges).toEqual(["down", "up"]);
    t.keydown(key(KEYCODES.Space, { ctrlKey: true, altKey: true }));
    t.set(null);
    expect(edges).toEqual(["down", "up", "down", "up"]);
    t.keyup(key(KEYCODES.Space));
    expect(edges).toHaveLength(4);
  });
});

describe("sameHotkey", () => {
  it("compares every field and treats two nulls as equal", () => {
    expect(sameHotkey(null, null)).toBe(true);
    expect(sameHotkey(F9, null)).toBe(false);
    expect(sameHotkey(null, F9)).toBe(false);
    expect(sameHotkey(F9, { ...F9 })).toBe(true);
    expect(sameHotkey(F9, { ...F9, shift: true })).toBe(false);
    expect(sameHotkey(F9, { ...F9, code: "F10" })).toBe(false);
  });
});

describe("UIOHOOK_KEY_NAME", () => {
  it("names a uiohook key for every hold-to-talk code", () => {
    expect(Object.keys(UIOHOOK_KEY_NAME).sort()).toEqual([...VOICE_HOTKEY_CODES].sort());
    expect(UIOHOOK_KEY_NAME.KeyA).toBe("A");
    expect(UIOHOOK_KEY_NAME.Digit1).toBe("1");
    expect(UIOHOOK_KEY_NAME.F9).toBe("F9");
    expect(UIOHOOK_KEY_NAME.Space).toBe("Space");
  });
});
