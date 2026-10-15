import { useEffect, useState } from "react";
import { STAGE_ADVANCE_MS, stageAdvanced } from "../stage-advance";

/**
 * The StageStepper advance (connector fill + lock-on ring): plays once when the
 * task moves forward a stage. The first render seeds the stage, and so does a
 * new `taskId`, so a reload or opening another task never plays it; fix rounds
 * (backward moves) don't either. Returns the advance's counter (part of the
 * React key, so a new advance replays the animation), or null when none plays.
 * An advance is dropped after `STAGE_ADVANCE_MS` (a timeout, since reduced
 * motion turns the animation off).
 */
export function useStageAdvance(taskId: string, index: number): number | null {
  const [seen, setSeen] = useState(() => ({ taskId, index }));
  const [advance, setAdvance] = useState<number | null>(null);

  // On each new stage, a forward move on the same task starts (or replays) the advance.
  if (taskId !== seen.taskId || index !== seen.index) {
    setSeen({ taskId, index });
    if (taskId !== seen.taskId) setAdvance(null);
    else if (stageAdvanced(seen.index, index)) setAdvance((a) => (a ?? 0) + 1);
  }

  useEffect(() => {
    if (advance === null) return;
    const timer = window.setTimeout(() => setAdvance(null), STAGE_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [advance]);

  return advance;
}
