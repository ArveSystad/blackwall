import type { Task } from "@blackwall/shared";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { answerGate, approvePlan, focusInputBar, type PlanComment } from "./actions";
import type { TaskAction } from "./use-task-action";

/**
 * The plan, with Approve plan and Request changes while it waits on the
 * user. Approval stays disabled while grill questions are open. A GitHub
 * issue task can also comment on its issue when the plan is approved.
 */
export function PlanPanel({
  task,
  action,
  draft,
  openQuestions,
  comment,
  onComment,
  className,
}: {
  task: Task;
  action: TaskAction;
  draft: string;
  openQuestions: number;
  comment: PlanComment;
  onComment: (comment: PlanComment) => void;
  className?: string;
}) {
  const atApproval = task.status === "needs-you" && task.gate === "plan-approval";
  const atQuestions = task.status === "needs-you" && task.gate === "questions";

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {task.plan ? (
          <Markdown className="max-w-3xl">{task.plan}</Markdown>
        ) : (
          <p className="m-0 text-muted-foreground">
            {task.status === "running" && task.stage === "inform"
              ? "Planner at work. Writing the plan."
              : "Standing by. The planner writes the plan in the Inform stage."}
          </p>
        )}
      </div>
      {(atApproval || atQuestions) && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {atApproval && task.origin.kind === "github-issue" && (
            <div className="flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-meta font-semibold text-foreground-strong">
                <input
                  type="checkbox"
                  className="focus:outline-none"
                  checked={comment.enabled}
                  onChange={(event) => onComment({ ...comment, enabled: event.target.checked })}
                />
                Comment on the issue
              </label>
              {comment.enabled && (
                <>
                  <Textarea
                    rows={4}
                    aria-label="Plan approval comment"
                    className="mono text-[12px]"
                    value={comment.body}
                    onChange={(event) => onComment({ ...comment, body: event.target.value })}
                  />
                  <span className="text-[11.5px] text-muted-foreground">
                    Posted on {task.origin.owner}/{task.origin.repo}#{task.origin.number}, signed as
                    blackwall&apos;s, when you approve.
                  </span>
                </>
              )}
            </div>
          )}
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
              onClick={() => void approvePlan(action, task, comment)}
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
