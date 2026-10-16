import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * Segmented control (`.seg`): pick one of a few options. Arrow keys move between them. Outer ends
 * chamfered: the first segment cuts its top-left corner, the last its bottom-right.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      disabled={disabled}
      // Radix reports "" when the selected item is pressed again; keep the selection.
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
      className={cn(
        "bw-chamfer inline-flex gap-0.5 self-start bg-muted p-0.5 [--bw-chamfer-line:var(--border)]",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="bw-chamfer bw-chamfer-seg bw-chamfer-focus inline-flex h-[26px] cursor-pointer items-center gap-1.5 px-2.5 text-meta font-medium text-muted-foreground [--bw-chamfer-line:transparent] [--bw-cut:7px] focus-visible:outline-none data-[state=on]:bg-seg-on data-[state=on]:text-foreground-strong data-[state=on]:[--bw-chamfer-line:var(--seg-on-ring)] data-disabled:cursor-default data-disabled:opacity-50"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
