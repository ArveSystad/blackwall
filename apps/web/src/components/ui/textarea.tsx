import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { useFieldControl } from "./field-context";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  const control = useFieldControl();
  return (
    <textarea
      {...control}
      className={cn(
        "bw-chamfer-box w-full resize-y bg-card px-2.5 py-1.5 text-body text-foreground-strong",
        className,
      )}
      {...props}
    />
  );
}
