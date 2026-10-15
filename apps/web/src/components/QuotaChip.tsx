import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { clockTime, pausedQuotas, quotaLabel } from "../backlog";
import { cn } from "../lib/utils";
import { quotaQuery } from "../query";
import { PausedIcon } from "./icons";
import { pill } from "./StatusBadge";

/**
 * Header chip while an agent CLI is paused on its usage limit; hidden
 * otherwise. Shows the earliest reset; the full list is in the tooltip.
 */
export function QuotaChip({ className }: { className?: string }) {
  const quota = useQuery(quotaQuery);
  const [now, setNow] = useState(() => new Date());
  // A stale clock still shows a fresh pause (it resets in the future); the tick ends it.
  const paused = pausedQuotas(quota.data ?? [], now);
  const active = (quota.data ?? []).some((q) => q.pausedUntil !== null);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (paused.length === 0) return null;
  const first = paused.toSorted((a, b) => a.pausedUntil!.getTime() - b.pausedUntil!.getTime())[0]!;
  const detail = paused.map((q) => quotaLabel(q, now)).join("; ");
  return (
    <span
      role="status"
      title={detail}
      aria-label={`Paused: ${detail}`}
      className={cn(pill, "gap-1 bg-interrupted/12 text-interrupted", className)}
    >
      <PausedIcon size="sm" />
      Quota · {clockTime(first.pausedUntil!)}
    </span>
  );
}
