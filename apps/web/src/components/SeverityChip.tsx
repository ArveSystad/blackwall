import type { Severity } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { SEVERITY_LABELS } from "../task-view";

const TONES: Record<Severity, string> = {
  critical: "text-sev-critical bg-sev-critical/14 border-sev-critical/35 before:bg-sev-critical",
  high: "text-sev-high bg-sev-high/14 border-sev-high/35 before:bg-sev-high",
  medium: "text-sev-medium bg-sev-medium/14 border-sev-medium/35 before:bg-sev-medium",
  low: "text-sev-low bg-sev-low/14 border-sev-low/35 before:bg-sev-low",
};

/** Severity chip (`.sev`). Severity colors never mean status. */
export function SeverityChip({
  severity,
  children = SEVERITY_LABELS[severity],
  className,
}: {
  severity: Severity;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-[5px] rounded-sm border pr-[7px] pl-1.5 text-label font-semibold tracking-[0.02em] whitespace-nowrap before:size-1.5 before:rounded-[1px] before:content-['']",
        TONES[severity],
        className,
      )}
    >
      {children}
    </span>
  );
}
