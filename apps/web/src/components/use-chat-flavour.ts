import { useEffect, useState } from "react";
import { nextPhrase, flavourDelayMs } from "../chat-flavour";
import { prefersReducedMotion } from "../reduced-motion";

/**
 * The flavour phrase for the chat's busy line. A fresh random phrase on mount
 * mid-turn and at each turn start; a different one on each new `activity` (a
 * tool call); and another every 2.5–4s (`flavourDelayMs`) while `busy`.
 * Reduced motion (read when the effect runs) skips the timer, so the phrase
 * then only changes with the turn and its tool calls. Cleanup clears the
 * pending timeout, so StrictMode's replay is safe.
 */
export function useChatFlavour(busy: boolean, activity: string | null): string {
  const [phrase, setPhrase] = useState<string | null>(() => (busy ? nextPhrase(null) : null));
  const [seen, setSeen] = useState({ busy, activity });

  if (busy !== seen.busy || activity !== seen.activity) {
    setSeen({ busy, activity });
    if (busy) setPhrase(nextPhrase(seen.busy ? phrase : null));
  }

  useEffect(() => {
    if (!busy || prefersReducedMotion()) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setPhrase((p) => nextPhrase(p));
        schedule();
      }, flavourDelayMs());
    };
    schedule();
    return () => clearTimeout(timer);
  }, [busy, activity]);

  return phrase ?? "Thinking…";
}
