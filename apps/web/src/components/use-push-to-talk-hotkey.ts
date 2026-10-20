import type { VoiceHotkey } from "@blackwall/shared";
import { useEffect, useRef } from "react";
import { isTypingTarget, useWindowKeydown } from "../keyboard";
import { desktopBridge, endsHotkey, hotkeyTypesText, matchesHotkeyDown } from "../voice-hotkey";

/**
 * Holds `hotkey` for push-to-talk: a press anywhere on the page, a text field
 * or select menu included unless the chord types a character there, calls
 * `onPress`, releasing the key or one of its modifiers (or leaving the
 * window) calls `onRelease`. In the desktop shell it also registers the key system-wide; the only caller of
 * `setPushToTalkHotkey`. Its down edges are ignored while the window has
 * focus, since the page sees the key itself then.
 */
export function usePushToTalkHotkey(
  hotkey: VoiceHotkey | null,
  { onPress, onRelease }: { onPress: () => void; onRelease: () => void },
): void {
  const handlers = useRef({ onPress, onRelease });
  useEffect(() => {
    handlers.current = { onPress, onRelease };
  });

  useWindowKeydown((event) => {
    if (!hotkey || event.repeat || !matchesHotkeyDown(event, hotkey)) return;
    if (isTypingTarget(event.target) && hotkeyTypesText(event)) return;
    event.preventDefault();
    handlers.current.onPress();
  }, hotkey !== null);

  const serialized = JSON.stringify(hotkey);
  useEffect(() => {
    const current = JSON.parse(serialized) as VoiceHotkey | null;
    if (!current) return;
    const held = current;
    function onKeyUp(event: KeyboardEvent) {
      if (endsHotkey(event, held)) handlers.current.onRelease();
    }
    function onBlur() {
      handlers.current.onRelease();
    }
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [serialized]);

  useEffect(() => {
    void desktopBridge()?.setPushToTalkHotkey(JSON.parse(serialized) as VoiceHotkey | null);
  }, [serialized]);

  useEffect(
    () =>
      desktopBridge()?.onPushToTalk((edge) => {
        if (edge === "up") handlers.current.onRelease();
        else if (!document.hasFocus()) handlers.current.onPress();
      }),
    [],
  );
}
