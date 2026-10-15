import type { Task } from "@blackwall/shared";
import { Fragment, type ReactNode } from "react";
import { UI_STAGES, uiStageIndex } from "../inbox";
import { cn } from "../lib/utils";
import { useStageAdvance } from "./use-stage-advance";

const CURRENT: Record<Task["status"], string> = {
  queued: "border-cyan text-cyan bg-cyan/14 shadow-glow-cyan",
  running: "border-running text-running bg-running/14 shadow-glow-cyan",
  "needs-you": "border-needs text-needs bg-needs/14 shadow-glow-needs",
  interrupted: "border-interrupted text-interrupted bg-interrupted/14",
  failed: "border-failed text-failed bg-failed/14",
  done: "border-done text-done bg-done/14",
};

/** Stage-advance tone by status; other statuses play no advance. */
const ADVANCE_TONE: Partial<Record<Task["status"], string>> = {
  running: "bw-stage-running",
  "needs-you": "bw-stage-needs",
};

/**
 * Pipeline stepper for the task header: done stages, the current node in the
 * status color, and `detail` (e.g. the review round) beside the current stage.
 * A forward stage move fills the connector into the new node and pulses it once.
 */
export function StageStepper({
  task,
  detail,
}: {
  task: Pick<Task, "id" | "stage" | "status">;
  detail?: ReactNode;
}) {
  const current = uiStageIndex(task);
  const advance = useStageAdvance(task.id, current);
  const tone = ADVANCE_TONE[task.status];
  const advancing = advance !== null && tone !== undefined;
  return (
    <ol className="flex flex-wrap items-center gap-y-1" aria-label="Pipeline">
      {UI_STAGES.map((stage, i) => {
        const done = i < current;
        const isCurrent = i === current;
        return (
          <Fragment key={stage.label}>
            {i > 0 && (
              <li
                aria-hidden="true"
                className={cn(
                  "relative mx-2 h-px w-5",
                  done || isCurrent ? "bg-faint" : "bg-border-strong",
                )}
              >
                {isCurrent && advancing && (
                  <span key={`fill:${advance}`} className={cn("bw-stage-fill", tone)} />
                )}
              </li>
            )}
            <li
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 text-meta whitespace-nowrap text-faint",
                done && "text-muted-foreground",
                isCurrent && "font-semibold text-foreground-strong",
              )}
            >
              <span
                className={cn(
                  "relative inline-flex size-[18px] items-center justify-center rounded-full border border-border-strong font-mono text-[10px]",
                  done && "bg-muted text-muted-foreground",
                  isCurrent && CURRENT[task.status],
                )}
              >
                {done ? "✓" : i + 1}
                {isCurrent && advancing && (
                  <span key={`lock:${advance}`} aria-hidden className={cn("bw-lock-on", tone)} />
                )}
              </span>
              {stage.label}
              {isCurrent && detail}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
