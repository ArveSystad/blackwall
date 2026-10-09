import {
  BACKLOG_PRIORITIES,
  MAX_TITLE_CHARS,
  type AgentCli,
  type BacklogItemView,
  type BacklogPriority,
  type GeneralSettings,
  type QuotaState,
  type RepoBacklogRunner,
  type Task,
  type TaskOrigin,
} from "@blackwall/shared";
import { groupTasks } from "./inbox";
import { CLI_NAMES } from "./settings-forms";

export const PRIORITY_LABELS: Record<BacklogPriority, string> = {
  high: "High",
  normal: "Normal",
  low: "Low",
};

export interface BacklogGroup {
  priority: BacklogPriority;
  items: BacklogItemView[];
}

/** Priority buckets, high first, each in the pick order the API returned. Empty buckets are left out. */
export function groupBacklog(items: readonly BacklogItemView[]): BacklogGroup[] {
  return BACKLOG_PRIORITIES.map((priority) => ({
    priority,
    items: items.filter((i) => i.priority === priority),
  })).filter((g) => g.items.length > 0);
}

export interface BacklogSections {
  /** Needs-you, running and queued tasks, from the backlog or not. */
  active: Task[];
  /** Priority buckets, without promoted items whose task is active. */
  groups: BacklogGroup[];
  /** Finished tasks no item links to (started outside the backlog). */
  earlier: Task[];
}

/**
 * The backlog view's layout: active tasks on top, then the priority buckets,
 * then finished tasks that never came from the backlog. `tasks` are the repo's.
 * An active task shows once, at the top, never also as its promoted item.
 */
export function backlogSections(
  items: readonly BacklogItemView[],
  tasks: readonly Task[],
): BacklogSections {
  const { needsYou, running, recent } = groupTasks(tasks);
  const active = [...needsYou, ...running];
  const activeIds = new Set(active.map((t) => t.id));
  const linked = new Set(items.flatMap((i) => (i.taskId ? [i.taskId] : [])));
  return {
    active,
    groups: groupBacklog(
      items.filter((i) => !(i.status === "promoted" && i.taskId && activeIds.has(i.taskId))),
    ),
    earlier: recent.filter((t) => !linked.has(t.id)),
  };
}

/** Items not yet promoted to a task (waiting or paused). */
export function pendingCount(items: readonly Pick<BacklogItemView, "status">[]): number {
  return items.filter((i) => i.status !== "promoted").length;
}

/**
 * The whole backlog's id order after moving `id` one step (`delta` -1 up,
 * +1 down) inside its priority bucket, or null when it cannot move further.
 * The reorder API wants every item of the repo listed once. With `shown`,
 * the step skips items not on screen, so a move never swaps with a hidden one.
 */
export function moveInBucket(
  items: readonly BacklogItemView[],
  id: string,
  delta: -1 | 1,
  shown?: ReadonlySet<string>,
): string[] | null {
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  const bucket = items.filter((i) => i.priority === item.priority && (!shown || shown.has(i.id)));
  const from = bucket.indexOf(item);
  const to = from + delta;
  if (to < 0 || to >= bucket.length) return null;
  return reorderIds(items, id, bucket[to]!.id);
}

/**
 * The whole backlog's id order after dropping `id` where `targetId` is,
 * inside one priority bucket (drag and drop). Null across buckets or onto itself.
 */
export function reorderIds(
  items: readonly BacklogItemView[],
  id: string,
  targetId: string,
): string[] | null {
  const item = items.find((i) => i.id === id);
  const target = items.find((i) => i.id === targetId);
  if (!item || !target || item === target || item.priority !== target.priority) return null;
  const ids = items.map((i) => i.id);
  const from = ids.indexOf(id);
  const to = ids.indexOf(targetId);
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/**
 * The item the runner would promote next, mirroring the server's pick: only
 * waiting items count, in pick order; a blocked item hands over to its unmet
 * dependencies (depth first). `skip` holds waiting items that sit out (their
 * CLI is quota-paused).
 */
export function nextBacklogItem(
  items: readonly BacklogItemView[],
  skip: ReadonlySet<string> = new Set(),
): BacklogItemView | undefined {
  const byId = new Map(items.map((i) => [i.id, i]));
  const resolve = (item: BacklogItemView, visiting: Set<string>): BacklogItemView | undefined => {
    if (visiting.has(item.id) || item.status !== "waiting" || skip.has(item.id)) return undefined;
    visiting.add(item.id);
    if (item.blockedBy.length === 0) return item;
    for (const depId of item.blockedBy) {
      const dep = byId.get(depId);
      if (!dep) return undefined;
      const ready = resolve(dep, visiting);
      if (ready) return ready;
    }
    return undefined;
  };
  for (const item of items) {
    const ready = resolve(item, new Set());
    if (ready) return ready;
  }
  return undefined;
}

export type BacklogItemState =
  | { kind: "next" }
  | { kind: "waiting" }
  | { kind: "paused" }
  | { kind: "blocked"; by: string[] }
  | { kind: "promoted"; task: Task | undefined };

/** What a row says about its item. `by` names the blocking items by title. */
export function itemState(
  item: BacklogItemView,
  {
    nextId,
    titles,
    tasks,
  }: {
    nextId: string | undefined;
    titles: ReadonlyMap<string, string>;
    tasks: ReadonlyMap<string, Task>;
  },
): BacklogItemState {
  if (item.status === "promoted") {
    return { kind: "promoted", task: item.taskId ? tasks.get(item.taskId) : undefined };
  }
  if (item.status === "paused") return { kind: "paused" };
  if (item.id === nextId) return { kind: "next" };
  if (item.blocked) {
    return { kind: "blocked", by: item.blockedBy.map((id) => titles.get(id) ?? "a deleted item") };
  }
  return { kind: "waiting" };
}

export type BacklogRowAction = { kind: "edit" } | { kind: "open-task"; taskId: string } | null;

/** What clicking a backlog row (or Enter on it) does. */
export function rowAction(state: BacklogItemState): BacklogRowAction {
  if (state.kind === "promoted") {
    return state.task ? { kind: "open-task", taskId: state.task.id } : null;
  }
  return { kind: "edit" };
}

/** CLIs paused on a usage limit right now, with when they reset. */
export function pausedQuotas(quota: readonly QuotaState[], now: Date): QuotaState[] {
  return quota.filter((q) => q.pausedUntil !== null && q.pausedUntil.getTime() > now.getTime());
}

/** `14:32` in local time. */
export function clockTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Countdown to `until`: `45s`, `12m`, `2h 05m`. */
export function countdown(until: Date, now: Date): string {
  const seconds = Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "Claude Code quota resets 14:32 (in 12m)". */
export function quotaLabel(q: QuotaState, now: Date): string {
  const until = q.pausedUntil ?? now;
  return `${CLI_NAMES[q.cli]} quota resets ${clockTime(until)} (in ${countdown(until, now)})`;
}

export type RunnerTone = "off" | "idle" | "waiting" | "paused" | "halted" | "ready";

export interface RunnerStatus {
  tone: RunnerTone;
  /** Short state word: Off, Idle, Waiting, Paused, Halted. */
  label: string;
  /** Why, in one line. */
  detail: string;
  /** The failed task that halted the runner. */
  haltedTaskId?: string;
}

export interface RunnerStatusInput {
  settings: Pick<
    GeneralSettings,
    "backlogRunner" | "maxTasksPerRepo" | "maxBacklogTasksPerRepo" | "stopBacklogOnNeedsYou"
  >;
  runner: RepoBacklogRunner;
  /** The repo's backlog, in pick order. */
  items: readonly BacklogItemView[];
  /** The repo's tasks. */
  tasks: readonly Task[];
  quota: readonly QuotaState[];
  /** The CLIs an item's agents run on (role defaults filled in). */
  clisFor: (item: BacklogItemView) => readonly AgentCli[];
  now: Date;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Why the runner is or isn't promoting something in this repo, checked in
 * the order the server's runner checks.
 */
export function runnerStatus({
  settings,
  runner,
  items,
  tasks,
  quota,
  clisFor,
  now,
}: RunnerStatusInput): RunnerStatus {
  const titleOf = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
  if (!settings.backlogRunner) {
    return { tone: "off", label: "Off", detail: "The backlog runner is switched off in Settings." };
  }
  if (!runner.enabled) {
    return { tone: "off", label: "Off", detail: "The runner is switched off for this repo." };
  }
  if (runner.haltedTaskId !== null) {
    return {
      tone: "halted",
      label: "Halted",
      detail: `Task “${titleOf(runner.haltedTaskId)}” failed. Resume to move on.`,
      haltedTaskId: runner.haltedTaskId,
    };
  }
  if (pendingCount(items) === 0) {
    return { tone: "idle", label: "Idle", detail: "The backlog is empty." };
  }

  const queued = tasks.filter((t) => t.status === "queued").length;
  if (queued > 0) {
    return {
      tone: "waiting",
      label: "Waiting",
      detail: `${plural(queued, "queued task")} ${queued === 1 ? "goes" : "go"} first.`,
    };
  }
  const running = tasks.filter((t) => t.status === "running").length;
  if (running >= settings.maxTasksPerRepo) {
    return { tone: "waiting", label: "Waiting", detail: `${plural(running, "task")} running.` };
  }
  const promoted = new Set(items.flatMap((i) => (i.taskId ? [i.taskId] : [])));
  const fromBacklog = tasks.filter((t) => promoted.has(t.id));
  const backlogRunning = fromBacklog.filter((t) => t.status === "running").length;
  if (backlogRunning >= settings.maxBacklogTasksPerRepo) {
    return {
      tone: "waiting",
      label: "Waiting",
      detail: `${plural(backlogRunning, "backlog task")} running.`,
    };
  }
  const needsYou = fromBacklog.find((t) => t.status === "needs-you");
  if (settings.stopBacklogOnNeedsYou && needsYou) {
    return {
      tone: "waiting",
      label: "Waiting",
      detail: `Backlog task “${needsYou.title}” needs you.`,
    };
  }

  const paused = pausedQuotas(quota, now);
  const pausedClis = new Set(paused.map((q) => q.cli));
  const skip = new Set(
    items
      .filter((i) => i.status === "waiting" && clisFor(i).some((cli) => pausedClis.has(cli)))
      .map((i) => i.id),
  );
  const next = nextBacklogItem(items, skip);
  if (next) {
    return { tone: "ready", label: "Idle", detail: `Next: ${next.title}` };
  }
  const held = nextBacklogItem(items);
  if (held) {
    const q = paused.find((p) => clisFor(held).includes(p.cli)) ?? paused[0]!;
    return { tone: "paused", label: "Paused", detail: quotaLabel(q, now) };
  }
  return {
    tone: "idle",
    label: "Idle",
    detail: "Nothing is ready: every item is paused or blocked.",
  };
}

/** A title for an item added from an origin: the Jira key, the PR, or the first line of the text. */
export function defaultBacklogTitle(origin: TaskOrigin, freeText: string): string {
  switch (origin.kind) {
    case "jira-issue":
      return origin.key;
    case "github-pr":
      return `${origin.owner}/${origin.repo}#${origin.number}`;
    case "free-text":
      return (freeText.split("\n").find((line) => line.trim()) ?? "")
        .trim()
        .slice(0, MAX_TITLE_CHARS);
  }
}
