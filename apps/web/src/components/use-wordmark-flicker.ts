import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../reduced-motion";
import { flickerDelayMs } from "../wordmark-flicker";

/**
 * A counter bumped once every 30–100s, a fresh random gap each time
 * (`flickerDelayMs`). Key the wordmark on it so `.bw-wordmark-flicker` replays;
 * it starts at 0, so first mount never flickers. Cleanup clears the pending
 * timeout, so StrictMode's replay is safe. Reduced motion (read on mount, like
 * `useDecrypt`) never schedules one.
 */
export function useWordmarkFlicker(): number {
  const [flicker, setFlicker] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setFlicker((n) => n + 1);
        schedule();
      }, flickerDelayMs());
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  return flicker;
}
