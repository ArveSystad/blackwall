import type { Task } from "@blackwall/shared";
import { UI_STAGES, uiStageIndex } from "../inbox";
import { cn } from "../lib/utils";

const CURRENT: Record<Task["status"], string> = {
  queued: "bg-muted-foreground",
  running: "bg-running text-running shadow-glow-pip",
  "needs-you": "bg-needs text-needs shadow-glow-pip",
  interrupted: "bg-interrupted text-interrupted shadow-glow-pip",
  failed: "bg-failed text-failed shadow-glow-pip",
  done: "bg-done",
};

/** Six-pip stage indicator: done stages, the current one in the status color, then the rest. */
export function StagePips({ task }: { task: Pick<Task, "stage" | "status"> }) {
  const current = uiStageIndex(task);
  const title =
    current >= UI_STAGES.length
      ? "Finished"
      : current < 0
        ? "Not started"
        : (UI_STAGES[current]?.label ?? "");
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={`Stage: ${title}`}>
      {UI_STAGES.map((stage, i) => (
        <span
          key={stage.label}
          className={cn(
            "h-1 w-3",
            i < current ? "bg-faint" : i === current ? CURRENT[task.status] : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}
