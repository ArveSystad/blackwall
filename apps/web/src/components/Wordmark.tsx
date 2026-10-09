import { WallIcon } from "./icons";

/** The blackwall wordmark; the only place Chakra Petch is used besides the first-run hero. */
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <WallIcon size="lg" className="size-5 text-cyan" />
      <span className="font-display text-[18px] leading-none font-semibold tracking-[0.14em] text-foreground-strong lowercase">
        black
        <span className="text-wordmark text-shadow-glow-cyan">wall</span>
      </span>
    </span>
  );
}
