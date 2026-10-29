import { useEffect, useRef, useState } from "react";
import { revealFrame, runReveal } from "../chat-stream";
import { prefersReducedMotion } from "../reduced-motion";

/**
 * The word-by-word reveal of a chat reply that may still be growing (the
 * streamed draft, or a final reply picking up where its draft stopped).
 * `from` characters show at once; with `play` the rest reveals, and text added
 * later reveals too. Returns the current frame, or null once caught up (or
 * never playing), when the caller shows `text` as it is. A start is caught
 * during render and begins from `revealFrame(text, from)`, so the full text
 * never flashes first; the frames run in a `[run]` effect, so StrictMode's
 * replay just restarts it. Reduced motion never plays: the text shows as it
 * arrives.
 */
export function useChatStream(
  text: string,
  { from, play }: { from: number; play: boolean },
): string | null {
  const [active] = useState(() => play && !prefersReducedMotion());
  /** How much of the text had been revealed when the last run caught up. */
  const [caughtUp, setCaughtUp] = useState(() => Math.min(from, text.length));
  const [run, setRun] = useState<{ from: number } | null>(() =>
    active && text.length > caughtUp ? { from: caughtUp } : null,
  );
  const [frame, setFrame] = useState<string | null>(() =>
    run !== null ? revealFrame(text, run.from) : null,
  );

  if (active && run === null) {
    if (text.length > caughtUp) {
      setRun({ from: caughtUp });
      setFrame(revealFrame(text, caughtUp));
    } else if (text.length < caughtUp) {
      // Replaced by a shorter text: what grows past its end reveals.
      setCaughtUp(text.length);
    }
  }

  // Read through a ref, so text that grows mid-run is followed.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (run === null) return;
    return runReveal({
      getTarget: () => textRef.current,
      from: run.from,
      onFrame: setFrame,
      onCaughtUp: (length) => {
        setCaughtUp(length);
        setFrame(null);
        setRun(null);
      },
    });
  }, [run]);

  return run === null ? null : frame;
}
