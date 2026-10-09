import type { ActiveAgentStep, Stage, Task } from "@blackwall/shared";

/** One dot on the empty pane's grid: a running agent, or a task that waits. */
export interface GridDot {
  /** `${taskId}:${slot}`, so a dot stays mounted as its task moves from step to step. */
  key: string;
  taskId: string;
  /** The running step; null between steps and for needs-you or queued tasks. */
  stepId: string | null;
  agentId: string | null;
  /** Index among the task's running steps, oldest first. */
  slot: number;
  state: "running" | "needs-you" | "queued";
}

/** Minimum distance between dot centres: the 24px hit target plus a 4px gap. */
export const DOT_SPACING = 28;

/** The floor under the horizon (58%) that home spots fall in, as fractions of the pane. */
const HOME_X = { min: 0.08, max: 0.92 };
const HOME_Y = { min: 0.64, max: 0.9 };
/** Dot centres keep this far from the pane's left and right edges. */
const EDGE = 16;

function byCreated(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

/**
 * The dots for the active tasks, oldest task first, then by slot: one per
 * running step of a running task (one with no step between steps), one
 * for a needs-you or queued task. Archived and finished tasks get none.
 */
export function gridDots(tasks: readonly Task[], active: readonly ActiveAgentStep[]): GridDot[] {
  const dots: GridDot[] = [];
  const shown = tasks
    .filter((t) => t.archivedAt === null)
    .filter((t) => t.status === "running" || t.status === "needs-you" || t.status === "queued")
    .sort(byCreated);
  for (const task of shown) {
    const base = { taskId: task.id, stepId: null, agentId: null, slot: 0, key: `${task.id}:0` };
    if (task.status === "needs-you" || task.status === "queued") {
      dots.push({ ...base, state: task.status });
      continue;
    }
    const steps = active.filter((s) => s.taskId === task.id).sort(byCreated);
    if (steps.length === 0) {
      dots.push({ ...base, state: "running" });
      continue;
    }
    steps.forEach((step, slot) =>
      dots.push({
        key: `${task.id}:${slot}`,
        taskId: task.id,
        stepId: step.id,
        agentId: step.agentId,
        slot,
        state: "running",
      }),
    );
  }
  return dots;
}

/** FNV-1a hash of a string, as an unsigned 32-bit integer. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A task's stable home spot on the floor, as fractions (0–1) of the pane's width and height. */
export function dotPosition(taskId: string): { x: number; y: number } {
  const hash = fnv1a(taskId);
  const fx = (hash & 0xffff) / 0xffff;
  const fy = (hash >>> 16) / 0xffff;
  return {
    x: HOME_X.min + fx * (HOME_X.max - HOME_X.min),
    y: HOME_Y.min + fy * (HOME_Y.max - HOME_Y.min),
  };
}

/** Offsets 0, +step, −step, +2·step, −2·step … that keep `base + offset` within [min, max]. */
function* offsets(base: number, min: number, max: number): Generator<number> {
  yield base;
  for (let n = 1; base + n * DOT_SPACING <= max || base - n * DOT_SPACING >= min; n++) {
    if (base + n * DOT_SPACING <= max) yield base + n * DOT_SPACING;
    if (base - n * DOT_SPACING >= min) yield base - n * DOT_SPACING;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Pixel centres for the dots in a `width` × `height` pane. Dots are placed in
 * order, so earlier ones keep their spot: one that would land within
 * `DOT_SPACING` of a placed dot tries sideways steps first, then rows above and
 * below within the floor. When the pane has no free spot, it keeps its home.
 */
export function layoutDots(
  dots: readonly GridDot[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  let xMin = EDGE;
  let xMax = width - EDGE;
  if (xMax < xMin) xMin = xMax = width / 2;
  let yMin = HOME_Y.min * height;
  let yMax = HOME_Y.max * height;
  if (yMax - yMin < DOT_SPACING) yMin = yMax = (yMin + yMax) / 2;

  const placed: { x: number; y: number }[] = [];
  const free = (x: number, y: number) =>
    placed.every((p) => Math.hypot(p.x - x, p.y - y) >= DOT_SPACING - 1e-6);

  const layout = new Map<string, { x: number; y: number }>();
  for (const dot of dots) {
    const home = dotPosition(dot.taskId);
    const hx = clamp(home.x * width + dot.slot * DOT_SPACING, xMin, xMax);
    const hy = clamp(home.y * height, yMin, yMax);
    let spot = { x: hx, y: hy };
    search: for (const y of offsets(hy, yMin, yMax)) {
      for (const x of offsets(hx, xMin, xMax)) {
        if (free(x, y)) {
          spot = { x, y };
          break search;
        }
      }
    }
    placed.push(spot);
    layout.set(dot.key, spot);
  }
  return layout;
}

/** Ids of the tasks whose stage differs from the one seen before; first sightings do not count. */
export function stageChanges(
  prev: ReadonlyMap<string, Stage | null>,
  tasks: readonly Task[],
): string[] {
  return tasks.filter((t) => prev.has(t.id) && prev.get(t.id) !== t.stage).map((t) => t.id);
}
