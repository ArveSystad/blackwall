import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border font-medium whitespace-nowrap text-foreground-strong no-underline hover:no-underline focus-visible:shadow-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-input bg-card hover:bg-muted",
        /** Primary CTA; at most one per view. */
        primary:
          "border-transparent bg-primary font-semibold text-primary-foreground shadow-glow-primary-btn hover:brightness-108",
        /** The CTA that resolves a needs-you state; at most one per view. */
        needs:
          "border-transparent bg-magenta font-semibold text-needs-foreground shadow-glow-needs hover:brightness-108",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground-strong",
      },
      size: {
        default: "h-7 px-2.5 text-[12.5px]",
        sm: "h-6 px-2 text-meta",
        icon: "size-7 justify-center p-0",
        "icon-sm": "size-6 justify-center p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  /** Render the child element (e.g. a router `Link`) with button styles. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
