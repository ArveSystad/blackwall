import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Segmented control (`.seg`): pick one of a few options. Arrow keys move between them. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      // Radix reports "" when the selected item is pressed again; keep the selection.
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
      className={cn(
        "inline-flex gap-0.5 self-start rounded-md border border-border bg-muted p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="inline-flex h-[26px] cursor-pointer items-center gap-1.5 rounded-sm px-2.5 text-meta font-medium text-muted-foreground focus-visible:shadow-ring focus-visible:outline-none data-[state=on]:bg-seg-on data-[state=on]:text-foreground-strong data-[state=on]:ring-1 data-[state=on]:ring-seg-on-ring"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
