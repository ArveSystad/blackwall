import { UI_STAGES } from "./inbox";

/**
 * How long a StageStepper advance plays; mirrors `.bw-stage-fill` / `.bw-lock-on`
 * in styles.css (the ring's 200ms delay + 600ms).
 */
export const STAGE_ADVANCE_MS = 800;

/**
 * Whether a stage index change is a forward move onto a stepper node with a
 * connector: fix rounds (backward), starts (from -1 or onto 0) and turning done
 * never count.
 */
export function stageAdvanced(prev: number, next: number): boolean {
  return next > prev && next > 0 && next < UI_STAGES.length;
}
