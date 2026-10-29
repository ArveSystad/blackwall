import type { Task } from "@blackwall/shared";
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
 * An inbox or Backlog row being archived. `task` is the row as it was when the archive
 * started, so it stays put while it crumbles. The row is dropped once it is
 * `gone` and `archived`; `failed` brings it back with a red flash, and
 * `failures` counts them so each flash replays.
 */
export interface Crumble {
  task: Task;
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
 * The tasks the inbox shows, given the rows crumbling out: a `gone` row is
 * left out, and a `crumbling` one shows its snapshot, so a live update that
 * marks it archived mid-animation doesn't drop it early.
 */
export function inboxRows(tasks: readonly Task[], crumbles: ReadonlyMap<string, Crumble>): Task[] {
  return tasks.flatMap((task) => {
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
