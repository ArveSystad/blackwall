import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { useFieldControl } from "./field-context";

/** Native select styled as an input: full keyboard support and no portal. */
export function Select({ className, ...props }: ComponentProps<"select">) {
  const control = useFieldControl();
  return (
    <select
      {...control}
      className={cn(
        "bw-chamfer-box h-[30px] w-full cursor-pointer bg-card px-2 text-body text-foreground-strong disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}
