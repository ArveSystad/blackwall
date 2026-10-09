import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const chipVariants = cva(
  "inline-flex h-5 items-center rounded-sm border px-1.5 text-[11.5px] font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border-strong text-muted-foreground",
        done: "border-done/40 text-done",
        cyan: "border-cyan/45 text-cyan",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

/** Outlined label for a kind or state, such as "Review PR" or "Answered". */
export function Chip({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof chipVariants>) {
  return <span className={cn(chipVariants({ tone }), className)} {...props} />;
}

/** Small filled mono tag, such as a stage or a finding's tag. */
export function Tag({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "mono inline-flex h-[18px] flex-none items-center rounded-xs bg-muted px-[5px] text-label text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
