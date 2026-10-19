import type { Step } from "@blackwall/shared";

type Timed = Pick<Step, "status" | "startedAt" | "finishedAt">;

/**
 * How long a step ran: up to `now` while it runs, null before it starts or when it stopped
 * without a finish time (left interrupted by a crash). Never negative.
 */
export function stepDurationMs(step: Timed, now: Date): number | null {
  if (step.startedAt === null) return null;
  const end = step.status === "running" ? now : step.finishedAt;
  if (end === null) return null;
  return Math.max(0, end.getTime() - step.startedAt.getTime());
}

/**
 * Time any finished step was running: the union of their intervals, so parallel reviewers count
 * once. Gaps between steps are left out on purpose: that is where the task waited on the user.
 */
export function activeTimeMs(steps: readonly Timed[]): number {
  const intervals = steps
    .flatMap((s) =>
      s.startedAt !== null && s.finishedAt !== null
        ? [[s.startedAt.getTime(), s.finishedAt.getTime()] as const]
        : [],
    )
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const [start, end] of intervals) {
    if (current && start <= current[1]) {
      current[1] = Math.max(current[1], end);
    } else {
      if (current) total += current[1] - current[0];
      current = [start, end];
    }
  }
  if (current) total += current[1] - current[0];
  return total;
}

/** From the first step's start to the last step's finish, waits included; null without both. */
export function wallClockMs(steps: readonly Timed[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const s of steps) {
    if (s.startedAt === null || s.finishedAt === null) continue;
    first = Math.min(first ?? Infinity, s.startedAt.getTime());
    last = Math.max(last ?? -Infinity, s.finishedAt.getTime());
  }
  return first === null || last === null ? null : Math.max(0, last - first);
}
