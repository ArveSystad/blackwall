import type { Task, TaskDoneTime } from "@blackwall/shared";
import { SUPERNOVA_MS, mixHash } from "./agent-dots";
import { startOfDay } from "./stats";

/** Minimum distance between star centres when the sky has room. */
export const STAR_SPACING = 14;

/**
 * How long a new star waits before it fades in, so it appears once the done
 * supernova ends. Mirrors `.bw-star-arrive`'s 1.2s delay in styles.css;
 * change them together.
 */
export const STAR_ARRIVE_DELAY_MS = SUPERNOVA_MS;

/** The sky band stars sit in, as fractions of the pane's height: above the horizon (58%). */
const SKY_Y = { min: 0.04, max: 0.54 };
/** Star centres keep this far from the pane's left and right edges. */
const EDGE = 8;
/** Hashed spots tried per star before it settles for a crowded one. */
const CANDIDATES = 8;
const HORIZON = 0.58;

/** A star's size (px) and brightness ranges, and its twinkle period (s). */
export const STAR_SIZE = { min: 2, max: 3.5 };
export const STAR_OPACITY = { min: 0.35, max: 0.7 };
export const TWINKLE_S = { min: 6, max: 14 };

/** One task done today, with when it was done. */
export interface TodayStar {
  task: Task;
  doneAt: Date;
}

/** Where a star sits and how it looks. */
export interface StarSpot {
  x: number;
  y: number;
  size: number;
  opacity: number;
  twinkleS: number;
  /** Negative, in (−twinkleS, 0], so stars don't twinkle together and nothing waits on mount. */
  twinkleDelayS: number;
}

/**
 * The tasks done today (from local midnight of `now`), archived ones
 * included, oldest first, then by id. A task that is no longer done or is
 * missing from `tasks` gets no star. Uncapped.
 */
export function starsToday(
  doneTimes: readonly TaskDoneTime[],
  tasks: ReadonlyMap<string, Task>,
  now: Date,
): TodayStar[] {
  const since = startOfDay(now).getTime();
  const stars: TodayStar[] = [];
  for (const { taskId, doneAt } of doneTimes) {
    const task = tasks.get(taskId);
    if (!task || task.status !== "done" || doneAt.getTime() < since) continue;
    stars.push({ task, doneAt });
  }
  return stars.sort(
    (a, b) => a.doneAt.getTime() - b.doneAt.getTime() || a.task.id.localeCompare(b.task.id),
  );
}

/**
 * The box the running sign (RunningSign.tsx) roughly fills: left of centre,
 * its bottom on the horizon, up to about 96px tall over its 28px lift.
 */
export function signZone(
  width: number,
  height: number,
): { left: number; right: number; top: number; bottom: number } {
  const bottom = HORIZON * height;
  return { left: 0, right: width / 2 - 16, top: bottom - 28 - 96, bottom };
}

/**
 * Pixel spots and looks for the stars in a `width` × `height` pane. Stars are
 * placed in order (oldest first), so earlier ones keep their spot. Each tries
 * up to `CANDIDATES` hashed spots in the sky band and takes the first outside
 * the sign's zone and `STAR_SPACING` clear of placed stars; failing that, the
 * first outside the zone, else its first spot.
 */
export function layoutStars(
  stars: readonly TodayStar[],
  width: number,
  height: number,
): Map<string, StarSpot> {
  let xMin = EDGE;
  let xMax = width - EDGE;
  if (xMax < xMin) xMin = xMax = width / 2;
  const yMin = SKY_Y.min * height;
  const yMax = SKY_Y.max * height;
  const zone = signZone(width, height);
  const inZone = (x: number, y: number) =>
    x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;

  const placed: { x: number; y: number }[] = [];
  const free = (x: number, y: number) =>
    placed.every((p) => Math.hypot(p.x - x, p.y - y) >= STAR_SPACING - 1e-6);

  const layout = new Map<string, StarSpot>();
  for (const { task } of stars) {
    const id = task.id;
    const candidates = Array.from({ length: CANDIDATES }, (_, k) => {
      const h = mixHash(k === 0 ? id : `${id}:${k}`);
      return {
        x: xMin + ((h & 0xffff) / 0xffff) * (xMax - xMin),
        y: yMin + ((h >>> 16) / 0xffff) * (yMax - yMin),
      };
    });
    const spot =
      candidates.find((c) => !inZone(c.x, c.y) && free(c.x, c.y)) ??
      candidates.find((c) => !inZone(c.x, c.y)) ??
      candidates[0]!;
    placed.push(spot);

    const look = mixHash(`${id}:star`);
    const unit = (shift: number) => ((look >>> shift) & 0xff) / 0xff;
    const twinkleS = TWINKLE_S.min + unit(16) * (TWINKLE_S.max - TWINKLE_S.min);
    layout.set(id, {
      x: spot.x,
      y: spot.y,
      size: STAR_SIZE.min + unit(0) * (STAR_SIZE.max - STAR_SIZE.min),
      opacity: STAR_OPACITY.min + unit(8) * (STAR_OPACITY.max - STAR_OPACITY.min),
      twinkleS,
      twinkleDelayS: -unit(24) * twinkleS,
    });
  }
  return layout;
}

/** Milliseconds from `now` to the next local midnight. */
export function msUntilNextMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * The star ids seen so far and those that just arrived. A null `seen` (the
 * first loaded snapshot) seeds every id with no arrivals, so a reload or a
 * remount never fades stars in. Ids that drop out stay seen.
 */
export function nextArrivals(
  seen: ReadonlySet<string> | null,
  ids: readonly string[],
): { seen: Set<string>; arrived: string[] } {
  if (seen === null) return { seen: new Set(ids), arrived: [] };
  const arrived = ids.filter((id) => !seen.has(id));
  if (arrived.length === 0) return { seen: new Set(seen), arrived };
  return { seen: new Set([...seen, ...arrived]), arrived };
}
