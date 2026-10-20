// Preload of the app window: the bridge the page uses for the system-wide
// hold-to-talk key (`window.blackwallDesktop`, typed in `apps/web/src/voice-hotkey.ts`).
// Sandboxed preloads must be CommonJS and may require only `electron`.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS import form
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

interface PttStatus {
  active: boolean;
  reason: string | null;
}

/** Subscribes to `channel`; returns the unsubscribe. */
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("blackwallDesktop", {
  /** Registers the hold-to-talk key system-wide (null turns it off); main validates it. */
  setPushToTalkHotkey: (hotkey: unknown): Promise<PttStatus> =>
    ipcRenderer.invoke("bw:ptt-hotkey", hotkey),
  getPushToTalkStatus: (): Promise<PttStatus> => ipcRenderer.invoke("bw:ptt-status"),
  onPushToTalkStatus: (callback: (status: PttStatus) => void) =>
    subscribe("bw:ptt-status", callback),
  onPushToTalk: (callback: (edge: "down" | "up") => void) => subscribe("bw:ptt", callback),
});
