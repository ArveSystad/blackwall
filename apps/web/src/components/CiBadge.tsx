import type { TaskCi } from "@blackwall/shared";
import { ciSummary, type CiTone } from "../ci";
import { cn } from "../lib/utils";
import { CheckIcon, FailedIcon, SpinnerIcon, WarnIcon } from "./icons";
import { pill } from "./StatusBadge";

const TONES: Record<CiTone, string> = {
  running: "text-running bg-running/12",
  passed: "text-done bg-done/12",
  failed: "text-failed bg-failed/12",
  muted: "text-muted-foreground bg-muted-foreground/12",
};

const ICONS = { running: SpinnerIcon, passed: CheckIcon, failed: FailedIcon, muted: WarnIcon };

/**
 * CI on the task's pushed commit: a spinner while it runs, green when it
 * passed, red with the failed count, grey when it timed out, has no checks or
 * can't be read. The icon and label carry the state, not color alone; the
 * tooltip names the commit, the failing checks and any hint. `compact` keeps
 * only the icon (and the failed count) for inbox cards.
 */
export function CiBadge({
  ci,
  compact = false,
  className,
}: {
  ci: TaskCi;
  compact?: boolean;
  className?: string;
}) {
  const { tone, label, title, failing } = ciSummary(ci);
  const Icon = ICONS[tone];
  return (
    <span
      className={cn(pill, TONES[tone], compact && "px-[5px]", className)}
      title={title}
      aria-label={compact ? label : undefined}
      role={compact ? "img" : undefined}
    >
      <Icon size="sm" className={cn(tone === "running" && "animate-spin")} />
      {compact ? tone === "failed" && <span className="mono">{failing.length}</span> : label}
    </span>
  );
}
