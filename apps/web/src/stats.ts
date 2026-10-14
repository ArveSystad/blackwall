import type { OriginKind, StepUsage, Task, TaskDoneTime } from "@blackwall/shared";
import { sumUsage, type UsageTotal } from "./usage";

/** How many days the per-day chart covers, ending today. */
export const STATS_DAYS = 10;

/** The task types the stats count, with the labels the New task modal uses. */
export const TASK_TYPES = [
  { key: "jira", label: "Jira issue", origin: "jira-issue" },
  { key: "pr-work", label: "Work on PR", origin: "github-pr" },
  { key: "pr-review", label: "Review PR", origin: "github-pr" },
  { key: "issue", label: "GitHub issue", origin: "github-issue" },
  { key: "free-text", label: "Blackwall", origin: "free-text" },
] as const satisfies readonly { key: string; label: string; origin: OriginKind }[];

export type TaskTypeKey = (typeof TASK_TYPES)[number]["key"];

/** A task's type: its origin, with PR tasks split by mode. */
export function taskType(task: Pick<Task, "origin" | "mode">): TaskTypeKey {
  switch (task.origin.kind) {
    case "jira-issue":
      return "jira";
    case "github-pr":
      return task.mode === "review" ? "pr-review" : "pr-work";
    case "github-issue":
      return "issue";
    case "free-text":
      return "free-text";
  }
}

export interface TaskStats {
  /** Done tasks, archived ones included. */
  resolved: number;
  byType: Record<TaskTypeKey, number>;
  /** Distinct repos with at least one task, whatever its status. */
  repos: number;
  /** Resolved tasks per local day, oldest first, ending today; null until the done times load. */
  perDay: { date: Date; count: number }[] | null;
}

/** Local midnight of the given time's calendar day. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Counts resolved tasks overall, per type and per local day. A done task's
 * day is its delivery run's finish time; a done task missing from the loaded
 * done times (older data) falls back to its `updatedAt`.
 */
export function taskStats(
  tasks: readonly Task[],
  doneTimes: readonly TaskDoneTime[] | undefined,
  now: Date,
  days = STATS_DAYS,
): TaskStats {
  const done = tasks.filter((t) => t.status === "done");
  const byType = Object.fromEntries(TASK_TYPES.map((t) => [t.key, 0])) as Record<
    TaskTypeKey,
    number
  >;
  for (const task of done) byType[taskType(task)] += 1;

  return {
    resolved: done.length,
    byType,
    repos: new Set(tasks.map((t) => t.repoId)).size,
    perDay: doneTimes ? perDay(done, doneTimes, now, days) : null,
  };
}

function perDay(
  done: readonly Task[],
  doneTimes: readonly TaskDoneTime[],
  now: Date,
  days: number,
): { date: Date; count: number }[] {
  // Stepping the calendar date (not adding 24h) keeps days whole across DST.
  const today = startOfDay(now);
  const buckets = Array.from({ length: days }, (_, i) => ({
    date: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i)),
    count: 0,
  }));
  const index = new Map(buckets.map((b, i) => [b.date.getTime(), i]));
  const doneAt = new Map(doneTimes.map((d) => [d.taskId, d.doneAt]));
  for (const task of done) {
    const at = doneAt.get(task.id) ?? task.updatedAt;
    const i = index.get(startOfDay(at).getTime());
    if (i !== undefined) buckets[i]!.count += 1;
  }
  return buckets;
}

export interface UsageStats {
  /** Usage per local day, oldest first, ending today. */
  perDay: { date: Date; total: UsageTotal }[];
  /** Usage per repo over all time, most tokens first. */
  perRepo: { repoId: string; total: UsageTotal }[];
}

/**
 * Adds up agent step usage per local day (by when the step started) and per
 * repo (through the step's task; steps of tasks not loaded are left out).
 */
export function usageStats(
  rows: readonly StepUsage[],
  tasks: readonly Task[],
  now: Date,
  days = STATS_DAYS,
): UsageStats {
  const today = startOfDay(now);
  const dayRows = Array.from({ length: days }, (_, i) => ({
    date: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i)),
    rows: [] as StepUsage[],
  }));
  const index = new Map(dayRows.map((d, i) => [d.date.getTime(), i]));
  const repoOf = new Map(tasks.map((t) => [t.id, t.repoId]));
  const repoRows = new Map<string, StepUsage[]>();
  for (const row of rows) {
    const i = index.get(startOfDay(row.at).getTime());
    if (i !== undefined) dayRows[i]!.rows.push(row);
    const repoId = repoOf.get(row.taskId);
    if (repoId === undefined) continue;
    const list = repoRows.get(repoId);
    if (list) list.push(row);
    else repoRows.set(repoId, [row]);
  }
  return {
    perDay: dayRows.map((d) => ({ date: d.date, total: sumUsage(d.rows) })),
    perRepo: [...repoRows]
      .map(([repoId, list]) => ({ repoId, total: sumUsage(list) }))
      .sort((a, b) => b.total.tokens - a.total.tokens),
  };
}

function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

/** The chart's screen reader text for one day: "Today: 3 resolved", "Thu 8 Oct: 0 resolved". */
export function dayLabel(date: Date, now: Date, count: number): string {
  const day = isSameDay(date, now)
    ? "Today"
    : date
        .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
        .replace(",", "");
  return `${day}: ${count} resolved`;
}

/** The chart's visible day label under a bar: "Today" or "Thu 8". */
export function shortDayLabel(date: Date, now: Date): string {
  if (isSameDay(date, now)) return "Today";
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }).replace(",", "");
}
