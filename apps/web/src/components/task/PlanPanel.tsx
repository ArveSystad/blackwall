import type { Task } from "@blackwall/shared";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { answerGate, focusInputBar } from "./actions";
import type { TaskAction } from "./use-task-action";

/**
 * The plan, with Approve plan and Request changes while it waits on the
 * user. Approval stays disabled while grill questions are open.
 */
export function PlanPanel({
  task,
  action,
  draft,
  openQuestions,
  className,
}: {
  task: Task;
  action: TaskAction;
  draft: string;
  openQuestions: number;
  className?: string;
}) {
  const atApproval = task.status === "needs-you" && task.gate === "plan-approval";
  const atQuestions = task.status === "needs-you" && task.gate === "questions";

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {task.plan ? (
          <div className="max-w-3xl font-sans text-body whitespace-pre-wrap text-foreground">
            {task.plan}
          </div>
        ) : (
          <p className="m-0 text-muted-foreground">
            {task.status === "running" && task.stage === "inform"
              ? "The planner is writing the plan."
              : "No plan yet. The planner writes it in the Inform stage."}
          </p>
        )}
      </div>
      {(atApproval || atQuestions) && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          <div className="flex gap-2">
            <Button
              className="flex-1 justify-center"
              disabled={!atApproval || action.pending}
              onClick={() => {
                if (!draft.trim()) {
                  focusInputBar();
                  return;
                }
                void answerGate(
                  action,
                  task,
                  { decision: "revise", message: draft.trim() },
                  "Request changes",
                );
              }}
            >
              Request changes
              <Kbd>R</Kbd>
            </Button>
            <Button
              variant="primary"
              className="flex-1 justify-center"
              disabled={!atApproval || action.pending}
              onClick={() => void answerGate(action, task, { decision: "approve" }, "Approve plan")}
            >
              Approve plan
              <Kbd onFill>A</Kbd>
            </Button>
          </div>
          <span className="text-center text-[11.5px] text-muted-foreground">
            {atQuestions
              ? `Approve unlocks once ${openQuestions === 1 ? "the open question is" : `all ${openQuestions} open questions are`} answered and the reviewers have seen the revised plan.`
              : "Type the requested changes in the input bar below; the planner re-plans with them."}
          </span>
        </div>
      )}
    </div>
  );
}
