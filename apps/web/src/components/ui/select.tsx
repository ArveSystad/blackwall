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
        "h-[30px] w-full cursor-pointer rounded-md border border-input bg-card px-2 text-body text-foreground-strong focus:border-cyan focus:shadow-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}
