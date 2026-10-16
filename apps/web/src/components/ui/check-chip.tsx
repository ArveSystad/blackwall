import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** A checkbox styled as a chip; the frame line turns primary while checked. */
export function CheckChip({
  checked,
  onCheckedChange,
  size = "md",
  className,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "bw-chamfer bw-chamfer-has-focus inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground [--bw-chamfer-line:var(--border-strong)]",
        size === "sm" ? "h-6 px-2 text-meta" : "h-7 px-2.5 text-[12.5px] font-medium",
        checked && "text-foreground-strong [--bw-chamfer-line:var(--primary)]",
        className,
      )}
    >
      <input
        type="checkbox"
        className="focus:outline-none"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {children}
    </label>
  );
}
