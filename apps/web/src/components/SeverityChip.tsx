import type { Severity } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { SEVERITY_LABELS } from "../task-view";

const TONES: Record<Severity, string> = {
  critical:
    "text-sev-critical bg-sev-critical/14 [--bw-chamfer-line:color-mix(in_oklab,var(--sev-critical)_35%,transparent)] before:bg-sev-critical",
  high: "text-sev-high bg-sev-high/14 [--bw-chamfer-line:color-mix(in_oklab,var(--sev-high)_35%,transparent)] before:bg-sev-high",
  medium:
    "text-sev-medium bg-sev-medium/14 [--bw-chamfer-line:color-mix(in_oklab,var(--sev-medium)_35%,transparent)] before:bg-sev-medium",
  low: "text-sev-low bg-sev-low/14 [--bw-chamfer-line:color-mix(in_oklab,var(--sev-low)_35%,transparent)] before:bg-sev-low",
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
        "bw-chamfer bw-chamfer-pill inline-flex h-5 items-center gap-[5px] pr-[7px] pl-1.5 text-label font-semibold tracking-[0.02em] whitespace-nowrap before:size-1.5 before:content-['']",
        TONES[severity],
        className,
      )}
    >
      {children}
    </span>
  );
}
