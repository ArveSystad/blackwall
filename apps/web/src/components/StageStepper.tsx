import type { Task } from "@blackwall/shared";
import { Fragment, type ReactNode } from "react";
import { UI_STAGES, uiStageIndex } from "../inbox";
import { cn } from "../lib/utils";

const CURRENT: Record<Task["status"], string> = {
  queued: "border-cyan text-cyan bg-cyan/14 shadow-glow-cyan",
  running: "border-running text-running bg-running/14 shadow-glow-cyan",
  "needs-you": "border-needs text-needs bg-needs/14 shadow-glow-needs",
  interrupted: "border-interrupted text-interrupted bg-interrupted/14",
  failed: "border-failed text-failed bg-failed/14",
  done: "border-done text-done bg-done/14",
};

/**
 * Pipeline stepper for the task header: done stages, the current node in the
 * status color, and `detail` (e.g. the review round) beside the current stage.
 */
export function StageStepper({
  task,
  detail,
}: {
  task: Pick<Task, "stage" | "status">;
  detail?: ReactNode;
}) {
  const current = uiStageIndex(task);
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
                className={cn("mx-2 h-px w-5", done || isCurrent ? "bg-faint" : "bg-border-strong")}
              />
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
                  "inline-flex size-[18px] items-center justify-center rounded-full border border-border-strong font-mono text-[10px]",
                  done && "bg-muted text-muted-foreground",
                  isCurrent && CURRENT[task.status],
                )}
              >
                {done ? "✓" : i + 1}
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
