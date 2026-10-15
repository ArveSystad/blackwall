import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { DecryptGlyphs } from "./DecryptText";
import { WallIcon } from "./icons";
import { useDecrypt } from "./use-decrypt";
import { useWordmarkFlicker } from "./use-wordmark-flicker";

/** Whether the wordmark has decrypted yet; it plays once per app load. */
let wordmarkDecrypted = false;

/**
 * The blackwall wordmark; the only place Chakra Petch is used besides the first-run hero.
 * It decrypts once on first app load: one `useDecrypt` frame split across `black` and `wall`,
 * so the whole word settles left to right and `wall` keeps its colour and glow.
 * Every 30–100s, icon and text flicker like a failing neon tube (`.bw-wordmark-flicker`),
 * replayed by keying the span on `useWordmarkFlicker`'s counter.
 */
export function Wordmark() {
  const [trigger] = useState(() => (wordmarkDecrypted ? null : "boot"));
  useEffect(() => {
    wordmarkDecrypted = true;
  }, []);
  const frame = useDecrypt("blackwall", trigger);
  const flicker = useWordmarkFlicker();

  return (
    <span
      key={flicker}
      className={cn("inline-flex items-center gap-3", flicker > 0 && "bw-wordmark-flicker")}
    >
      <WallIcon size="lg" className="size-6 text-cyan" />
      <span className="font-display text-[21px] leading-none font-semibold tracking-[0.14em] text-foreground-strong lowercase">
        <DecryptGlyphs text="black" frame={frame?.slice(0, 5) ?? null} />
        <span className="text-wordmark text-shadow-glow-cyan">
          <DecryptGlyphs text="wall" frame={frame?.slice(5) ?? null} />
        </span>
      </span>
    </span>
  );
}
