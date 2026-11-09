import type { Repo, Task } from "@blackwall/shared";
import { HOME_X, HORIZON_Y, mixHash } from "./agent-dots";

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
  /** Done tasks, archived ones included. */
  doneCount: number;
  /** Stacking order, 1..n: 1 is the tallest (furthest back), shorter towers stand in front. */
  z: number;
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

/** The shortest tower, for a repo with no done tasks. */
export const MIN_H = 12;
/** Repos with this many done tasks or more reach the tallest tower. */
export const DONE_CAP = 64;
/** The tallest a tower gets on a tall pane. */
const MAX_H = 120;
/** A tower's width bounds; at this width or wider it gets two window columns. */
export const MIN_W = 4;
export const MAX_W = 24;
const TWO_COLUMNS_W = 14;
/** The narrowest nominal width, before the cluster shrinks to fit. */
export const NOMINAL_MIN_W = 10;
/** The share of the space right of the running sign the towers' widths may fill. */
export const DENSITY = 0.55;
/** Neighbours overlap by at most this share of the narrower one. */
export const MAX_OVERLAP = 0.4;
/** The chance a tower stands apart from its left neighbour instead of overlapping it. */
const GAP_CHANCE = 0.15;
/** Every tower shows at least this much face: its window span. */
export const MIN_VISIBLE = 3;
/** The cluster keeps this far right of the pane's centre, clear of the running sign. */
export const SIGN_CLEAR = 16;
/** Where the cluster centres, as a fraction of the pane's width. */
export const CLUSTER_X = 0.68;
/** A window's width and the gap between two window columns (`.bw-tower-window`). */
export const WINDOW_W = 3;
export const COLUMN_GAP = 4;
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

/** Per repo id, how many of its tasks are done, archived ones included. */
export function repoDoneCounts(
  tasks: Iterable<Pick<Task, "repoId" | "status">>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.status !== "done" || !task.repoId) continue;
    counts.set(task.repoId, (counts.get(task.repoId) ?? 0) + 1);
  }
  return counts;
}

/**
 * A tower's height for `doneCount` done tasks in a pane `paneHeight` tall: on a
 * log scale from `MIN_H` (none) to the cap at `DONE_CAP` tasks, where the
 * cap is 18% of the pane, at least `MIN_H` and at most 120px.
 */
export function towerHeight(doneCount: number, paneHeight: number): number {
  const maxH = clamp(0.18 * paneHeight, MIN_H, MAX_H);
  const n = Math.max(0, doneCount);
  const t = Math.min(1, Math.log2(1 + n) / Math.log2(1 + DONE_CAP));
  return MIN_H + (maxH - MIN_H) * t;
}

/** A seeded PRNG: the same `seed` always yields the same sequence in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * The towers for `repos` in a `width` × `height` pane, as a city cluster on
 * the horizon right of centre, opposite the running sign. Each repo's id seeds
 * its place in the order, its nominal width (10–24px) and how it meets its
 * left neighbour: mostly a shallow overlap, now and then a small gap. Widths
 * shrink together, by one factor, only once the cluster would fill more than
 * `DENSITY` of the space right of the sign. Overlaps only cover the plain wall
 * outside a tower's window columns, so no window is ever hidden, whichever
 * tower stands in front; shorter towers stand in front (`z`). Each tower's
 * height comes from its done tasks, with lit windows for its live tasks,
 * needs-you first, from the bottom. Returned left to right.
 */
export function layoutSkyline(
  repos: readonly Pick<Repo, "id" | "name" | "favorite">[],
  doneCounts: ReadonlyMap<string, number>,
  activity: ReadonlyMap<string, { running: number; needs: number }>,
  width: number,
  height: number,
): Tower[] {
  if (repos.length === 0) return [];
  const bandL = HOME_X.min * width;
  const bandR = HOME_X.max * width;
  const bandW = bandR - bandL;
  const zoneL = width / 2 + SIGN_CLEAR;
  const zoneW = Math.max(0, bandR - zoneL);

  const seeded = repos
    .map((repo) => {
      const random = mulberry32(mixHash(repo.id));
      const orderKey = random();
      const widthRoll = random();
      const gapRoll = random();
      const spacingRoll = random();
      return {
        repo,
        orderKey,
        nominal: NOMINAL_MIN_W + (MAX_W - NOMINAL_MIN_W) * widthRoll,
        gapRoll,
        spacingRoll,
      };
    })
    .sort(
      (a, b) =>
        a.orderKey - b.orderKey || (a.repo.id < b.repo.id ? -1 : a.repo.id > b.repo.id ? 1 : 0),
    );

  const nominalSum = seeded.reduce((sum, s) => sum + s.nominal, 0);
  const shrink = Math.min(1, (DENSITY * zoneW) / nominalSum);
  const widths = seeded.map((s) => Math.max(MIN_W, shrink * s.nominal));

  // The centre-to-centre step from each tower's left neighbour to it.
  const steps = seeded.map((s, i) => {
    if (i === 0) return 0;
    const prev = widths[i - 1]!;
    const own = widths[i]!;
    const narrow = Math.min(prev, own);
    const overlap =
      s.gapRoll < GAP_CHANCE
        ? -(0.1 + 0.3 * s.spacingRoll) * narrow
        : s.spacingRoll * Math.min(MAX_OVERLAP * narrow, windowInset(prev), windowInset(own));
    return (prev + own) / 2 - overlap;
  });
  const stepSum = steps.reduce((sum, step) => sum + step, 0);
  const first = widths[0]!;
  const last = widths[widths.length - 1]!;
  const extent = first / 2 + stepSum + last / 2;

  let left = Math.min(Math.max(CLUSTER_X * width - extent / 2, zoneL), bandR - extent);
  let squeeze = 1;
  if (extent > bandW) {
    squeeze = stepSum > 0 ? Math.max(0, (bandW - (first + last) / 2) / stepSum) : 1;
    left = bandL;
  }

  const base = HORIZON_Y * height;
  let x = left + first / 2;
  const towers = seeded.map((s, index): Tower => {
    if (index > 0) x += steps[index]! * squeeze;
    const towerW = widths[index]!;
    const columns = windowColumns(towerW);
    const { repo } = s;
    const doneCount = doneCounts.get(repo.id) ?? 0;
    const { running, needs } = activity.get(repo.id) ?? { running: 0, needs: 0 };
    const h = towerHeight(doneCount, height);
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
      x,
      width: towerW,
      height: h,
      top: base - h,
      base,
      doneCount,
      z: 0,
      running,
      needs,
      windows,
    };
  });

  // Tallest at the back (z 1), shortest in front; equal heights by x order.
  const byDepth = towers.map((tower, index) => ({ tower, index }));
  byDepth.sort((a, b) => b.tower.height - a.tower.height || a.index - b.index);
  byDepth.forEach(({ tower }, rank) => {
    tower.z = rank + 1;
  });
  return towers;
}

/** The width of `columns` window columns, gaps included: 3px for one, 10px for two. */
export function windowSpan(columns: number): number {
  return columns * WINDOW_W + (columns - 1) * COLUMN_GAP;
}

/** The plain wall on each side of the window columns of a tower `width` wide. */
export function windowInset(width: number): number {
  return Math.max(0, (width - windowSpan(windowColumns(width))) / 2);
}

/** Window columns for a tower `width` wide: two from 14px, else one. */
export function windowColumns(width: number): 1 | 2 {
  return width >= TWO_COLUMNS_W ? 2 : 1;
}
