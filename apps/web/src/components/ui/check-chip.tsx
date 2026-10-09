import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/** A checkbox styled as a chip; the border turns primary while checked. */
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
        "inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-input text-muted-foreground has-focus-visible:shadow-ring",
        size === "sm" ? "h-6 px-2 text-meta" : "h-7 px-2.5 text-[12.5px] font-medium",
        checked && "border-primary text-foreground-strong",
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
