import type { ProjectRun, ProjectRunStatus } from "@blackwall/shared";

/**
 * A reactor pylon's look at its repo's tower (`GridReactors`): a cyan flicker
 * while the project starts, a green hum while it runs, a dim fade while it
 * stops, and a one-shot red sputter when it crashes.
 */
export type ReactorVisual = "power-up" | "hum" | "power-down" | "sputter";

/**
 * The steady pylon for a run's status, or null for none. Non-null exactly
 * while `isRunActive` (project-run.ts); a failed run shows only as the
 * one-shot sputter from `reactorSputters`.
 */
export function reactorVisual(status: ProjectRunStatus): Exclude<ReactorVisual, "sputter"> | null {
  switch (status) {
    case "starting":
      return "power-up";
    case "running":
      return "hum";
    case "stopping":
      return "power-down";
    default:
      return null;
  }
}

const STATUS_LABELS: Partial<Record<ProjectRunStatus, string>> = {
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  failed: "Failed",
};

/** The pylon card's status label; the same words as the run output's chip. */
export function reactorStatusLabel(status: ProjectRunStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** One repo's run in a snapshot. */
export interface RunSnapshot {
  runId: string;
  status: ProjectRunStatus;
}

/** Each repo's latest run, by repo id: the snapshot `reactorSputters` compares against. */
export function runStatusMap(runs: Iterable<ProjectRun>): Map<string, RunSnapshot> {
  return new Map([...runs].map((run) => [run.repoId, { runId: run.runId, status: run.status }]));
}

/**
 * Ids of the repos, in `runs` order, whose run turned failed since the
 * snapshot. A repo missing from the snapshot, or whose same run was already
 * failed, does not count, so a reload never sputters.
 */
export function reactorSputters(
  prev: ReadonlyMap<string, RunSnapshot>,
  runs: readonly ProjectRun[],
): string[] {
  return runs
    .filter((run) => {
      if (run.status !== "failed") return false;
      const before = prev.get(run.repoId);
      if (!before) return false;
      return !(before.status === "failed" && before.runId === run.runId);
    })
    .map((run) => run.repoId);
}

/** Mirrors `.bw-reactor-sputter` in styles.css; `useReactorSputters` drops a sputter after it. */
export const REACTOR_SPUTTER_MS = 900;

/** Mirrors the `.bw-reactor[data-visual="hum"]::after` halo period in styles.css. */
export const REACTOR_HUM_S = 2.4;
