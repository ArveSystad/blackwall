import type { Stage, Task, TaskStatus } from "@blackwall/shared";

/** The six stages the UI shows, in order; aggregate and summarize fold into their neighbours. */
export const UI_STAGES = [
  { label: "Inform", stages: ["inform"] },
  { label: "Plan review", stages: ["plan-review"] },
  { label: "Implement", stages: ["implement"] },
  { label: "Checks", stages: ["checks"] },
  { label: "Code review", stages: ["code-review", "aggregate"] },
  { label: "Finish", stages: ["summarize"] },
] as const satisfies readonly { label: string; stages: readonly Stage[] }[];

/**
 * Index into `UI_STAGES` of the task's current stage: -1 before the first
 * step, `UI_STAGES.length` once the task is done.
 */
export function uiStageIndex(task: Pick<Task, "stage" | "status">): number {
  if (task.status === "done") return UI_STAGES.length;
  if (task.stage === null) return -1;
  const stage = task.stage;
  return UI_STAGES.findIndex((s) => (s.stages as readonly Stage[]).includes(stage));
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  "needs-you": "Needs you",
  interrupted: "Interrupted",
  failed: "Failed",
  done: "Done",
};

/** Short origin label: Jira key, `owner/repo#42`, or "blackwall". */
export function originKey(task: Pick<Task, "origin">): string {
  const { origin } = task;
  switch (origin.kind) {
    case "jira-issue":
      return origin.key;
    case "github-pr":
    case "github-issue":
      return `${origin.owner}/${origin.repo}#${origin.number}`;
    case "free-text":
      return "blackwall";
  }
}

export interface InboxGroups {
  needsYou: Task[];
  /** Running and queued. */
  running: Task[];
  /** Interrupted, failed and done, without archived tasks. */
  recent: Task[];
}

/**
 * Inbox groups, needs-you first; each group lists the most recently updated
 * task first. Archived tasks are left out.
 */
export function groupTasks(tasks: readonly Task[]): InboxGroups {
  const sorted = tasks
    .filter((t) => t.archivedAt === null)
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return {
    needsYou: sorted.filter((t) => t.status === "needs-you"),
    running: sorted.filter((t) => t.status === "running" || t.status === "queued"),
    recent: sorted.filter(
      (t) => t.status === "interrupted" || t.status === "failed" || t.status === "done",
    ),
  };
}

export function needsYouCount(tasks: readonly Pick<Task, "status">[]): number {
  return tasks.filter((t) => t.status === "needs-you").length;
}

/** "1 active agent", "3 active agents"; null when none run. */
export function activeAgentsLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} active agent${count === 1 ? "" : "s"}`;
}

/** Case-insensitive match on title and origin key. */
export function matchesFilter(task: Task, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  return (
    task.title.toLowerCase().includes(needle) || originKey(task).toLowerCase().includes(needle)
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative time for cards: `now`, `5m`, `3h`, `yday`, `4d`. */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 2 * DAY) return "yday";
  return `${Math.floor(elapsed / DAY)}d`;
}
