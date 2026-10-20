import { voiceHotkeySchema } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { ariaKeyShortcuts, endsHotkey, hotkeyFromEvent, matchesHotkeyDown } from "./voice-hotkey";

/** Fake key event: a plain F9 unless overridden. */
function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: "F9",
    code: "F9",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

const F9 = { code: "F9", ctrl: false, alt: false, shift: false, meta: false };
const CTRL_ALT_SPACE = { code: "Space", ctrl: true, alt: true, shift: false, meta: false };

describe("hotkeyFromEvent", () => {
  it("returns the chord of a key press", () => {
    expect(hotkeyFromEvent(keyEvent())).toEqual(F9);
    expect(
      hotkeyFromEvent(keyEvent({ key: " ", code: "Space", ctrlKey: true, altKey: true })),
    ).toEqual(CTRL_ALT_SPACE);
  });

  it("is null for a lone modifier or a key outside the allow-list", () => {
    expect(hotkeyFromEvent(keyEvent({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBe(
      null,
    );
    expect(hotkeyFromEvent(keyEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBe(
      null,
    );
    expect(hotkeyFromEvent(keyEvent({ key: "Escape", code: "Escape" }))).toBeNull();
    expect(hotkeyFromEvent(keyEvent({ key: "/", code: "Slash", ctrlKey: true }))).toBeNull();
  });

  it("returns reserved chords unvalidated, for the schema to reject", () => {
    for (const event of [
      keyEvent({ key: "w", code: "KeyW", ctrlKey: true }),
      keyEvent({ key: "s", code: "KeyS", ctrlKey: true }),
    ]) {
      const chord = hotkeyFromEvent(event);
      expect(chord).not.toBeNull();
      expect(voiceHotkeySchema.safeParse(chord).success).toBe(false);
    }
  });
});

describe("matchesHotkeyDown", () => {
  it("matches the key with exactly its modifiers", () => {
    expect(matchesHotkeyDown(keyEvent(), F9)).toBe(true);
    expect(
      matchesHotkeyDown(keyEvent({ code: "Space", ctrlKey: true, altKey: true }), CTRL_ALT_SPACE),
    ).toBe(true);
    expect(matchesHotkeyDown(keyEvent({ shiftKey: true }), F9)).toBe(false);
    expect(matchesHotkeyDown(keyEvent({ code: "Space", ctrlKey: true }), CTRL_ALT_SPACE)).toBe(
      false,
    );
    expect(matchesHotkeyDown(keyEvent({ code: "F8" }), F9)).toBe(false);
  });
});

describe("endsHotkey", () => {
  it("ends on the key or a required modifier going up", () => {
    expect(endsHotkey(keyEvent(), F9)).toBe(true);
    expect(endsHotkey(keyEvent({ key: " ", code: "Space" }), CTRL_ALT_SPACE)).toBe(true);
    expect(endsHotkey(keyEvent({ key: "Control", code: "ControlLeft" }), CTRL_ALT_SPACE)).toBe(
      true,
    );
    expect(endsHotkey(keyEvent({ key: "Alt", code: "AltRight" }), CTRL_ALT_SPACE)).toBe(true);
  });

  it("does not end on other keys or modifiers it does not need", () => {
    expect(endsHotkey(keyEvent({ key: "Control", code: "ControlLeft" }), F9)).toBe(false);
    expect(endsHotkey(keyEvent({ key: "Shift", code: "ShiftLeft" }), CTRL_ALT_SPACE)).toBe(false);
    expect(endsHotkey(keyEvent({ key: "a", code: "KeyA" }), CTRL_ALT_SPACE)).toBe(false);
  });
});

describe("ariaKeyShortcuts", () => {
  it("joins the modifiers and key with +", () => {
    expect(ariaKeyShortcuts(F9)).toBe("F9");
    expect(ariaKeyShortcuts(CTRL_ALT_SPACE)).toBe("Control+Alt+Space");
    expect(ariaKeyShortcuts({ ...F9, code: "KeyP", meta: true, shift: true })).toBe("Shift+Meta+P");
  });
});
