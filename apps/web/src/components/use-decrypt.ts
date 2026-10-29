import { useEffect, useRef, useState } from "react";
import { decryptStart, encryptEnd, encryptFrame, runDecrypt } from "../decrypt";
import { prefersReducedMotion } from "../reduced-motion";

/**
 * The glyph-scramble decrypt of `text` (`DecryptText`, `DecryptGlyphs`).
 * Plays on mount when `trigger` is non-null, and again each time `trigger`
 * changes to a non-null value, so pass something stable: an id, or a counter
 * bumped during render. Returns the current scrambled frame, or null when
 * settled or idle. A new trigger is caught during render and starts from
 * `decryptStart`, so the plain text never flashes first; the frames run in a
 * `[run]` effect, so StrictMode's replay just restarts it. Reduced motion
 * never plays.
 */
export function useDecrypt(text: string, trigger: string | number | null): string | null {
  const [seen, setSeen] = useState(trigger);
  const [run, setRun] = useState<number | null>(() =>
    trigger != null && !prefersReducedMotion() ? 1 : null,
  );
  const [frame, setFrame] = useState<string | null>(() =>
    run !== null ? decryptStart(text) : null,
  );

  if (trigger !== seen) {
    setSeen(trigger);
    if (trigger != null && !prefersReducedMotion()) {
      setRun((r) => (r ?? 0) + 1);
      setFrame(decryptStart(text));
    }
  }

  // Read through a ref, so a text change mid-run settles to the new text.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (run === null) return;
    return runDecrypt({
      getText: () => textRef.current,
      onFrame: setFrame,
      onDone: () => {
        setFrame(null);
        setRun(null);
      },
    });
  }, [run]);

  return frame;
}

/**
 * The decrypt played in reverse: `text` scrambles into glyphs left to right,
 * then holds the fully scrambled frame (`encryptEnd`). Starts `delayMs` after
 * `active` turns true. Returns null while inactive, during the delay and
 * under reduced motion, which never plays. The timer and frames run in an
 * effect keyed on `active` and `delayMs`, so StrictMode's replay just
 * restarts it.
 */
export function useEncrypt(text: string, active: boolean, delayMs: number): string | null {
  const [frame, setFrame] = useState<string | null>(null);

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (!active || prefersReducedMotion()) return;
    let cancel: (() => void) | null = null;
    const timer = window.setTimeout(() => {
      cancel = runDecrypt({
        getText: () => textRef.current,
        onFrame: setFrame,
        onDone: () => setFrame(encryptEnd(textRef.current)),
        frame: encryptFrame,
      });
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
      cancel?.();
      setFrame(null);
    };
  }, [active, delayMs]);

  return frame;
}
