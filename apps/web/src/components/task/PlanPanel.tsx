import type { Task } from "@blackwall/shared";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { Button } from "../ui/button";
import { focusTaskChat } from "../../chat";
import { modKeyLabel } from "../../keyboard";
import { isSplitParent, planHasSubtasks } from "../../subtasks";
import { Kbd } from "../ui/kbd";
import { Textarea } from "../ui/textarea";
import { approvePlan, type PlanComment } from "./actions";
import { ProposedSubtasks, StartedSubtasks } from "./SubtaskList";
import type { TaskAction } from "./use-task-action";

/**
 * The plan, with Approve plan and Request changes while it waits on the
 * user; Request changes moves to the task channel above the tabs, where the
 * change requests are typed. Approval stays disabled while grill questions are open. A GitHub
 * issue task can also comment on its issue when the plan is approved. A plan split into
 * subtasks lists them: proposed ones at approval, which approving starts, and afterwards the
 * tasks it started with their status.
 */
export function PlanPanel({
  task,
  action,
  openQuestions,
  comment,
  onComment,
  className,
}: {
  task: Task;
  action: TaskAction;
  openQuestions: number;
  comment: PlanComment;
  onComment: (comment: PlanComment) => void;
  className?: string;
}) {
  const atApproval = task.status === "needs-you" && task.gate === "plan-approval";
  const atQuestions = task.status === "needs-you" && task.gate === "questions";
  const proposals = atApproval ? task.subtasks.length : 0;
  const unusable = atApproval && proposals === 0 && planHasSubtasks(task.plan);
  const issueOrigin = task.origin.kind === "github-issue" || task.origin.kind === "jira-issue";

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        {isSplitParent(task) && (
          <section aria-label="Subtasks" className="mb-4 flex max-w-3xl flex-col gap-2">
            <h3 className="label m-0 text-muted-foreground">Subtasks</h3>
            <StartedSubtasks task={task} />
          </section>
        )}
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
          {proposals > 0 && (
            <section aria-label="Subtasks to start" className="flex flex-col gap-1.5">
              <ProposedSubtasks task={task} />
              <span className="text-[11.5px] text-muted-foreground">
                Approving starts these {proposals} subtasks in their repos. This task then waits for
                them; follow-ups are proposed by the subtasks.
                {issueOrigin &&
                  " Once all are done, you confirm a comment on the issue listing their pull requests."}
              </span>
            </section>
          )}
          {unusable && (
            <span className="text-[11.5px] text-muted-foreground">
              The plan has a Subtasks section, but none of its subtasks named a usable repo.
              Approving implements the plan in this repo; request changes to split it.
            </span>
          )}
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
              onClick={focusTaskChat}
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
              {proposals > 0 ? "Approve & start subtasks" : "Approve plan"}
              <Kbd onFill>A</Kbd>
            </Button>
          </div>
          <span className="text-center text-[11.5px] text-muted-foreground">
            {atQuestions
              ? `Approve unlocks once ${openQuestions === 1 ? "the open question is" : `all ${openQuestions} open questions are`} answered and the reviewers have seen the revised plan.`
              : `Describe the requested changes in the task channel above; its "Request changes · planner" button (${modKeyLabel("⇧↵")}) sends them to the planner.`}
          </span>
        </div>
      )}
    </div>
  );
}
