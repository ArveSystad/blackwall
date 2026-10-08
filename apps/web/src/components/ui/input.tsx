import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-[30px] w-full rounded-md border border-input bg-card px-2.5 text-body text-foreground-strong focus:border-cyan focus:shadow-ring focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}
