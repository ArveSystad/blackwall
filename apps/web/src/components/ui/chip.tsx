import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const chipVariants = cva(
  "bw-chamfer bw-chamfer-pill inline-flex h-5 items-center px-1.5 text-[11.5px] font-medium",
  {
    variants: {
      tone: {
        neutral: "text-muted-foreground [--bw-chamfer-line:var(--border-strong)]",
        done: "text-done [--bw-chamfer-line:color-mix(in_oklab,var(--st-done)_40%,transparent)]",
        cyan: "text-cyan [--bw-chamfer-line:color-mix(in_oklab,var(--cyan)_45%,transparent)]",
        failed:
          "text-failed [--bw-chamfer-line:color-mix(in_oklab,var(--st-failed)_45%,transparent)]",
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
        "bw-chamfer bw-chamfer-pill mono inline-flex h-[18px] flex-none items-center bg-muted px-[5px] text-label text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
