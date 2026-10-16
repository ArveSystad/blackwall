import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { useFieldControl } from "./field-context";

export function Input({ className, ...props }: ComponentProps<"input">) {
  const control = useFieldControl();
  return (
    <input
      {...control}
      className={cn(
        "bw-chamfer-box h-[30px] w-full bg-card px-2.5 text-body text-foreground-strong",
        className,
      )}
      {...props}
    />
  );
}
