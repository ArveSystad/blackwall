import {
  ciNeedsYou,
  originRef,
  type Stage,
  type Task,
  type TaskOrigin,
  type TaskStatus,
} from "@blackwall/shared";

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

/** The status pill's label: "Finishing" while a needs-you task delivers, else the status label. */
export function statusLabel(task: Pick<Task, "status" | "delivering">): string {
  return task.status === "needs-you" && task.delivering ? "Finishing" : STATUS_LABELS[task.status];
}

/** Short origin label: Jira key, `owner/repo#42`, or "blackwall". */
export function originKey(task: Pick<Task, "origin">): string {
  const { origin } = task;
  return origin.kind === "free-text" ? "blackwall" : originRef(origin);
}

/**
 * A stacked PR's place in its stack, for metadata lines: `stack #41 · 2/3`,
 * with the whole stack as tooltip. Undefined for other origins.
 */
export function stackLabel(origin: TaskOrigin): { text: string; title: string } | undefined {
  if (origin.kind !== "github-pr" || !origin.stack) return undefined;
  const { prs } = origin.stack;
  const at = prs.indexOf(origin.number);
  return {
    text: `stack #${prs[0]}${at === -1 ? "" : ` · ${at + 1}/${prs.length}`}`,
    title: `Stacked PRs: ${prs.map((n) => `#${n}`).join(" → ")}`,
  };
}

/** Whether the task needs the user: it waits at a gate, or it is done and its CI failed. */
export function isNeedsYou(task: Pick<Task, "status" | "archivedAt" | "ci">): boolean {
  return task.status === "needs-you" || ciNeedsYou(task);
}

export interface InboxGroups {
  /** Waiting at a gate, or done with failed CI. */
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
    needsYou: sorted.filter(isNeedsYou),
    running: sorted.filter((t) => t.status === "running" || t.status === "queued"),
    recent: sorted.filter(
      (t) =>
        (t.status === "interrupted" || t.status === "failed" || t.status === "done") &&
        !ciNeedsYou(t),
    ),
  };
}

/** Done tasks not archived yet, for Archive all done. */
export function doneTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.status === "done" && t.archivedAt === null);
}

/** Tasks that need the user (see {@link isNeedsYou}), for the title and desktop badges. */
export function needsYouCount(
  tasks: readonly Pick<Task, "status" | "archivedAt" | "ci">[],
): number {
  return tasks.filter(isNeedsYou).length;
}

/**
 * Ids of the tasks, in `tasks` order, whose status differs from the one seen
 * before: the cards that sweep their new status colour. Archived tasks, first
 * sightings, unchanged statuses and turns to queued (no status colour) do not
 * count.
 */
export function statusChanges(
  prev: ReadonlyMap<string, TaskStatus>,
  tasks: readonly Task[],
): string[] {
  return tasks
    .filter(
      (t) =>
        t.archivedAt === null &&
        t.status !== "queued" &&
        prev.has(t.id) &&
        prev.get(t.id) !== t.status,
    )
    .map((t) => t.id);
}

/**
 * The status sweeps after one update, by task id: each changed id that is
 * shown has its counter bumped, and every id that is not shown is dropped, so
 * a card shown again later does not replay a stale sweep.
 */
export function nextSweeps(
  sweeps: ReadonlyMap<string, number>,
  changed: readonly string[],
  shown: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map([...sweeps].filter(([id]) => shown.has(id)));
  for (const id of changed) {
    if (shown.has(id)) next.set(id, (next.get(id) ?? 0) + 1);
  }
  return next;
}

/**
 * Ids of the tasks, in `tasks` order, never seen before: the cards that may
 * arrive. Archived tasks do not count.
 */
export function newTaskIds(seen: ReadonlySet<string>, tasks: readonly Task[]): string[] {
  return tasks.filter((t) => t.archivedAt === null && !seen.has(t.id)).map((t) => t.id);
}

/**
 * The arrivals after one update: each added id that is shown arrives, and
 * every id that is not shown is dropped, so a card shown again later does not
 * replay a stale arrival.
 */
export function nextArrivals(
  arrivals: ReadonlySet<string>,
  added: readonly string[],
  shown: ReadonlySet<string>,
): Set<string> {
  const next = new Set([...arrivals].filter((id) => shown.has(id)));
  for (const id of added) {
    if (shown.has(id)) next.add(id);
  }
  return next;
}

/**
 * "1 active agent", "3 active agents"; null when none run. With sub-agents
 * running, appends their count: ", 1 sub-agent", ", 5 sub-agents".
 */
export function activeAgentsLabel(count: number, subagents = 0): string | null {
  if (count <= 0) return null;
  const agents = `${count} active agent${count === 1 ? "" : "s"}`;
  if (subagents <= 0) return agents;
  return `${agents}, ${subagents} sub-agent${subagents === 1 ? "" : "s"}`;
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
