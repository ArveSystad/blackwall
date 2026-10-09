import type { TaskStatus } from "@blackwall/shared";
import { STATUS_LABELS } from "../inbox";
import { cn } from "../lib/utils";

const TONES: Record<TaskStatus, { badge: string; dot: string }> = {
  queued: { badge: "text-muted-foreground bg-muted-foreground/12", dot: "bg-muted-foreground" },
  running: { badge: "text-running bg-running/12", dot: "bg-running animate-pulse-running" },
  "needs-you": {
    badge: "text-needs bg-needs/12 shadow-glow-status-needs",
    dot: "bg-needs animate-blink-needs",
  },
  interrupted: { badge: "text-interrupted bg-interrupted/12", dot: "bg-interrupted" },
  failed: { badge: "text-failed bg-failed/12", dot: "bg-failed" },
  done: { badge: "text-done bg-done/12", dot: "bg-done" },
};

/** The status pill's shape; add a tone's text and background color. */
export const pill =
  "inline-flex h-5 items-center gap-[5px] rounded-full px-[7px] text-label font-semibold whitespace-nowrap";

/** Task status pill. The label and dot animation carry the state, not color alone. */
export function StatusBadge({
  status,
  label = STATUS_LABELS[status],
  className,
}: {
  status: TaskStatus;
  label?: string;
  className?: string;
}) {
  const tone = TONES[status];
  return (
    <span className={cn(pill, tone.badge, className)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden="true" />
      {label}
    </span>
  );
}
