import type { Repo, Task } from "@blackwall/shared";
import { HOME_X, HORIZON_Y } from "./agent-dots";

/** A tower window: lit cyan for a running task, magenta for one that needs you, or dark. */
export type WindowState = "running" | "needs-you" | "off";

/** One registered repo as a tower on the home grid's horizon, in pane pixels. */
export interface Tower {
  repoId: string;
  name: string;
  favorite: boolean;
  /** The tower's centre. */
  x: number;
  width: number;
  height: number;
  /** The roof: `base − height`. */
  top: number;
  /** The horizon the tower stands on: `HORIZON_Y · paneHeight`. */
  base: number;
  /** Open backlog items. */
  backlog: number;
  /** Unarchived running tasks; exact, though the lit windows are capped. */
  running: number;
  /** Unarchived needs-you tasks; exact, though the lit windows are capped. */
  needs: number;
  /** Bottom row first, left to right within a row: needs-you, then running, then off. */
  windows: WindowState[];
}

/** What the pointer or focus is on: a task's dot (or its sub-agent's) or a repo's tower. */
export type GridHot = { taskId: string } | { repoId: string } | null;

/** The repo whose tower the hot dot or tower lights: the hot tower's, or the hot dot's task's. */
export function hotRepo(
  hot: GridHot,
  tasks: ReadonlyMap<string, Pick<Task, "repoId">>,
): string | null {
  if (!hot) return null;
  if ("repoId" in hot) return hot.repoId;
  return tasks.get(hot.taskId)?.repoId ?? null;
}

/** The shortest tower, for an empty backlog. */
export const MIN_H = 12;
/** Backlogs this long or longer reach the tallest tower. */
export const BACKLOG_CAP = 64;
/** The tallest a tower gets on a tall pane. */
const MAX_H = 120;
/** A tower's width bounds; at this width or wider it gets two window columns. */
const MIN_W = 4;
const MAX_W = 24;
const TWO_COLUMNS_W = 14;
/** A window row's pitch: a 4px window and a 3px gap. */
export const ROW_PITCH = 7;
/** The space above and below the window rows; the bottom row sits half of it off the floor. */
const WINDOW_PAD = 6;
export const WINDOW_BOTTOM = WINDOW_PAD / 2;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Per repo id, how many of its unarchived tasks are running and how many need you. */
export function repoActivity(
  tasks: Iterable<Pick<Task, "repoId" | "status" | "archivedAt">>,
): Map<string, { running: number; needs: number }> {
  const activity = new Map<string, { running: number; needs: number }>();
  for (const task of tasks) {
    if (task.archivedAt !== null || !task.repoId) continue;
    if (task.status !== "running" && task.status !== "needs-you") continue;
    const entry = activity.get(task.repoId) ?? { running: 0, needs: 0 };
    if (task.status === "running") entry.running++;
    else entry.needs++;
    activity.set(task.repoId, entry);
  }
  return activity;
}

/**
 * A tower's height for `backlog` open items in a pane `paneHeight` tall: on a
 * log scale from `MIN_H` (empty) to the cap at `BACKLOG_CAP` items, where the
 * cap is 18% of the pane, at least `MIN_H` and at most 120px.
 */
export function towerHeight(backlog: number, paneHeight: number): number {
  const maxH = clamp(0.18 * paneHeight, MIN_H, MAX_H);
  const n = Math.max(0, backlog);
  const t = Math.min(1, Math.log2(1 + n) / Math.log2(1 + BACKLOG_CAP));
  return MIN_H + (maxH - MIN_H) * t;
}

/**
 * The towers for `repos` in a `width` × `height` pane, in the order given
 * (the repo list's: favourites, then position, then name). Each stands on the
 * horizon in an equal slot across the band dots use (`HOME_X`), with its
 * height from its backlog and lit windows for its live tasks, needs-you first,
 * from the bottom.
 */
export function layoutSkyline(
  repos: readonly Pick<Repo, "id" | "name" | "favorite">[],
  backlogCounts: ReadonlyMap<string, number>,
  activity: ReadonlyMap<string, { running: number; needs: number }>,
  width: number,
  height: number,
): Tower[] {
  if (repos.length === 0) return [];
  const left = HOME_X.min * width;
  const pitch = ((HOME_X.max - HOME_X.min) * width) / repos.length;
  const towerW = clamp(pitch * 0.55, MIN_W, MAX_W);
  const base = HORIZON_Y * height;
  const columns = windowColumns(towerW);
  return repos.map((repo, index) => {
    const backlog = backlogCounts.get(repo.id) ?? 0;
    const { running, needs } = activity.get(repo.id) ?? { running: 0, needs: 0 };
    const h = towerHeight(backlog, height);
    const rows = Math.max(1, Math.floor((h - WINDOW_PAD) / ROW_PITCH));
    const total = rows * columns;
    const lit = Math.min(needs, total);
    const windows: WindowState[] = Array.from({ length: total }, (_, i) =>
      i < lit ? "needs-you" : i < Math.min(lit + running, total) ? "running" : "off",
    );
    return {
      repoId: repo.id,
      name: repo.name,
      favorite: repo.favorite,
      x: left + pitch * (index + 0.5),
      width: towerW,
      height: h,
      top: base - h,
      base,
      backlog,
      running,
      needs,
      windows,
    };
  });
}

/** Window columns for a tower `width` wide: two from 14px, else one. */
export function windowColumns(width: number): 1 | 2 {
  return width >= TWO_COLUMNS_W ? 2 : 1;
}
