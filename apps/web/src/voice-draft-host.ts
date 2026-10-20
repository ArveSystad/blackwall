import { useSyncExternalStore } from "react";

/**
 * Hand-opened New task forms in this tab that take the voice draft instead of
 * `VoiceTaskModal`. Tab-local: other tabs keep showing the voice modal.
 */
const listeners = new Set<() => void>();
let hosts = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Claims the voice draft for a form; the returned release gives it back, once. */
export function claimVoiceDraftHost(): () => void {
  hosts += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hosts -= 1;
    notify();
  };
}

/** Whether a form in this tab hosts the voice draft. */
export function voiceDraftHosted(): boolean {
  return hosts > 0;
}

export function subscribeVoiceDraftHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** {@link voiceDraftHosted}, re-rendering when it changes. */
export function useVoiceDraftHosted(): boolean {
  return useSyncExternalStore(subscribeVoiceDraftHost, voiceDraftHosted, () => false);
}
