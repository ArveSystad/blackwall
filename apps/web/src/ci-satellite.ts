import type { Task } from "@blackwall/shared";
import { ciSummary } from "./ci";

/** A CI satellite's look: cyan blinking while CI runs, green when passed, red fast blink when failed. */
export type SatelliteTone = "running" | "passed" | "failed";

/**
 * The satellite orbiting a delivered task's grid dot, or null for none: only
 * done tasks with CI get one, in the same tone as `CiBadge` (`ciSummary`).
 * Timed-out, no and unreadable CI read muted there and get no satellite here.
 */
export function ciSatellite(task: Pick<Task, "status" | "ci">): SatelliteTone | null {
  if (task.status !== "done" || !task.ci) return null;
  const { tone } = ciSummary(task.ci);
  return tone === "muted" ? null : tone;
}

/** Each task's satellite tone, by id: the snapshot `satelliteChanges` compares against. */
export function satelliteMap(tasks: Iterable<Task>): Map<string, SatelliteTone | null> {
  return new Map([...tasks].map((task) => [task.id, ciSatellite(task)]));
}

/**
 * Ids of the tasks, in `tasks` order, whose satellite turned to a new tone
 * since the snapshot; first sightings and turns to no satellite do not count,
 * so a reload never flashes.
 */
export function satelliteChanges(
  prev: ReadonlyMap<string, SatelliteTone | null>,
  tasks: readonly Task[],
): string[] {
  return tasks
    .filter((t) => {
      if (!prev.has(t.id)) return false;
      const tone = ciSatellite(t);
      return tone !== null && tone !== prev.get(t.id);
    })
    .map((t) => t.id);
}

/**
 * Mirror the `.bw-satellite-running/passed/failed` orbit durations in
 * styles.css; each task's orbit phase is `pulseDelay(taskId, period)`.
 */
export const SATELLITE_ORBIT_S: Record<SatelliteTone, number> = {
  running: 6,
  passed: 12,
  failed: 6,
};

/** Mirrors `.bw-satellite-flash` in styles.css; `useCiFlashes` drops a flash after it. */
export const SATELLITE_FLASH_MS = 600;
