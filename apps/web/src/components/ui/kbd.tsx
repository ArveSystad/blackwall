import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

/** Keyboard hint. Inside a filled button, pass `onFill` so it reads on the fill color. */
export function Kbd({ className, onFill, ...props }: ComponentProps<"kbd"> & { onFill?: boolean }) {
  return (
    <kbd
      className={cn(
        "bw-chamfer-box inline-flex h-[18px] min-w-[18px] items-center justify-center border-b-2 bg-card px-[5px] font-mono text-[10.5px] leading-4 text-muted-foreground [--bw-cut:4px]",
        onFill && "bg-kbd-on-fill text-inherit [--bw-chamfer-line:var(--kbd-on-fill-border)]",
        className,
      )}
      {...props}
    />
  );
}
