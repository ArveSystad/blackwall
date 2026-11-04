import type { BacklogItemView, Task } from "@blackwall/shared";
import { DECRYPT_MS } from "./decrypt";
import { groupTasks } from "./inbox";

/** How long an archived inbox or Backlog row flickers and falls; mirrors `.bw-crumble`'s duration in styles.css. */
export const CRUMBLE_FALL_MS = 360;

/**
 * How long an archived inbox or Backlog row crumbles before it is dropped: the title
 * scrambles (`DECRYPT_MS`), then the row falls. Mirrors `.bw-crumble`'s delay
 * plus duration in styles.css, like `LAUNCH_MS`.
 */
export const CRUMBLE_MS = DECRYPT_MS + CRUMBLE_FALL_MS;

/** The step between rows crumbling together, top to bottom; mirrors `--crumble-delay` on `.bw-crumble`. */
export const CRUMBLE_STAGGER_MS = 70;

/** How long a row whose archive failed flashes red; mirrors `.bw-crumble-failed` in styles.css. */
export const CRUMBLE_FAILED_MS = 1200;

/**
 * An inbox or Backlog row being archived, or deleted (`kind`). `task` is the
 * row as it was when the archive started, so it stays put while it crumbles.
 * The row is dropped once it is `gone` and `archived`; `failed` brings it back
 * with a red flash, and `failures` counts them so each flash replays. A delete
 * crumbles red only once the delete succeeded, so it never fails; `itemId` is
 * the backlog item that promoted the deleted task, if any.
 */
export interface Crumble {
  task: Task;
  kind: "archive" | "delete";
  itemId?: string | undefined;
  delayMs: number;
  phase: "crumbling" | "gone" | "failed";
  archived: boolean;
  failures: number;
}

/** Each task's crumble delay, staggered in the order the inbox shows them. */
export function crumbleDelays(tasks: readonly Task[]): Map<string, number> {
  const groups = groupTasks(tasks);
  const ordered = [...groups.needsYou, ...groups.running, ...groups.recent];
  return new Map(ordered.map((task, index) => [task.id, index * CRUMBLE_STAGGER_MS]));
}

/**
 * `tasks` plus the snapshot of each deleted task still crumbling, which has
 * already left the tasks cache, so its row stays until the animation ends.
 * `crumbles` spans every repo, so a per-repo caller filters after this.
 */
export function withDeleting(
  tasks: readonly Task[],
  crumbles: ReadonlyMap<string, Crumble>,
): Task[] {
  const ids = new Set(tasks.map((t) => t.id));
  const deleting = [...crumbles.values()].flatMap((crumble) =>
    crumble.kind === "delete" && crumble.phase === "crumbling" && !ids.has(crumble.task.id)
      ? [crumble.task]
      : [],
  );
  return deleting.length === 0 ? [...tasks] : [...tasks, ...deleting];
}

/**
 * `items` with the link back to each deleted task still crumbling: deleting a
 * task clears its item's `taskId`, which would move the row before it has
 * crumbled, so the item keeps it until the animation ends.
 */
export function withDeletingLinks(
  items: readonly BacklogItemView[],
  crumbles: ReadonlyMap<string, Crumble>,
): BacklogItemView[] {
  const links = new Map<string, string>();
  for (const crumble of crumbles.values()) {
    if (crumble.kind === "delete" && crumble.phase === "crumbling" && crumble.itemId) {
      links.set(crumble.itemId, crumble.task.id);
    }
  }
  if (links.size === 0) return [...items];
  return items.map((item) => {
    const taskId = links.get(item.id);
    return taskId && item.taskId === null ? { ...item, taskId } : item;
  });
}

/**
 * The tasks the inbox shows, given the rows crumbling out: a `gone` row is
 * left out, and a `crumbling` one shows its snapshot, so a live update that
 * marks it archived mid-animation doesn't drop it early. A deleted row is
 * kept as its snapshot while it crumbles (`withDeleting`).
 */
export function inboxRows(tasks: readonly Task[], crumbles: ReadonlyMap<string, Crumble>): Task[] {
  return withDeleting(tasks, crumbles).flatMap((task) => {
    const crumble = crumbles.get(task.id);
    if (!crumble || crumble.phase === "failed") return [task];
    return crumble.phase === "gone" ? [] : [crumble.task];
  });
}

/**
 * The repo's tasks as the Backlog lays them out, given the rows crumbling
 * out. Unlike `inboxRows`, a `gone` row is not left out, since the Backlog
 * reads a promoted item whose task is missing as "task removed": it shows as
 * archived at `now` until the live task is, so it joins the archive without
 * popping back. A `crumbling` row shows its snapshot, so it stays put.
 */
export function backlogTasks(
  tasks: readonly Task[],
  crumbles: ReadonlyMap<string, Crumble>,
  now: Date,
): Task[] {
  return tasks.map((task) => {
    const crumble = crumbles.get(task.id);
    if (!crumble || crumble.phase === "failed") return task;
    if (crumble.phase === "crumbling") return crumble.task;
    return task.archivedAt !== null ? task : { ...crumble.task, archivedAt: now };
  });
}
