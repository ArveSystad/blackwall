import { useEffect, useState } from "react";
import { desktopBridge, type PttStatus } from "../voice-hotkey";

/** The desktop shell's system-wide hold-to-talk status; null in a browser. */
export function useDesktopPttStatus(): PttStatus | null {
  const [status, setStatus] = useState<PttStatus | null>(null);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;
    let live = true;
    void bridge.getPushToTalkStatus().then((initial) => {
      if (live) setStatus(initial);
    });
    const unsubscribe = bridge.onPushToTalkStatus(setStatus);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return status;
}
