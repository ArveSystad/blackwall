import { ciNeedsYou, IMPORT_INTERRUPTED_ERROR, type Task } from "@blackwall/shared";
import { cn } from "../../lib/utils";
import {
  ciBanner,
  deleteBlockedReason,
  gateBanner,
  isStoppedByUser,
  type TaskTab,
} from "../../task-view";
import { FailedIcon, PausedIcon, StopIcon } from "../icons";
import { NeedsBanner } from "../NeedsBanner";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";
import { Kbd } from "../ui/kbd";
import { answerGate, approvePlan, fixCi, resume, type PlanComment } from "./actions";
import type { TaskAction } from "./use-task-action";

export interface BannerCounts {
  openQuestions: number;
  blocking: number;
  round: number;
}

function NeedsActions({
  task,
  action,
  counts,
  draft,
  planComment,
  tab,
  onTab,
}: {
  task: Task;
  action: TaskAction;
  counts: BannerCounts;
  draft: string;
  planComment: PlanComment;
  tab: TaskTab;
  onTab: (tab: TaskTab) => void;
}) {
  const message = draft.trim() ? { message: draft.trim() } : {};
  switch (task.gate) {
    case "questions":
      return tab === "grill" ? null : (
        <Button variant="needs" onClick={() => onTab("grill")}>
          Answer questions
        </Button>
      );
    case "plan-approval":
      return (
        <>
          <Button variant="ghost" disabled={action.pending} onClick={() => onTab("plan")}>
            Request changes
            <Kbd>R</Kbd>
          </Button>
          <Button
            variant="needs"
            disabled={action.pending}
            onClick={() => void approvePlan(action, task, planComment)}
          >
            Approve plan
            <Kbd onFill>A</Kbd>
          </Button>
        </>
      );
    case "triage":
      if (task.mode === "review") {
        return tab === "finish" ? null : (
          <Button variant="needs" onClick={() => onTab("finish")}>
            Choose findings to post
          </Button>
        );
      }
      return (
        <>
          {tab !== "findings" && (
            <Button variant="ghost" onClick={() => onTab("findings")}>
              Open findings
            </Button>
          )}
          <Button
            variant="needs"
            disabled={action.pending}
            onClick={() =>
              void answerGate(action, task, { decision: "approve", ...message }, "Start fix round")
            }
          >
            Start fix round {counts.round + 1}
          </Button>
        </>
      );
    case "escalation":
      return (
        <>
          <Button
            variant="ghost"
            disabled={action.pending}
            onClick={() =>
              void answerGate(action, task, { decision: "revise", ...message }, "One more round")
            }
          >
            One more fix round
          </Button>
          <Button
            variant="needs"
            disabled={action.pending}
            onClick={() => void answerGate(action, task, { decision: "approve" }, "Accept as is")}
          >
            Accept as is
          </Button>
        </>
      );
    case "finish":
      return tab === "finish" ? null : (
        <Button variant="needs" onClick={() => onTab("finish")}>
          Review outbound actions
        </Button>
      );
    default:
      return null;
  }
}

/**
 * Needs-you banner (a gate, or failed CI on a done task with Fix CI), or the
 * interrupted / failed card with Resume. Nothing for other states.
 */
export function TaskBanner({
  task,
  action,
  counts,
  draft,
  planComment,
  tab,
  onTab,
  onDelete,
}: {
  task: Task;
  action: TaskAction;
  counts: BannerCounts;
  draft: string;
  /** The plan approval's issue comment, shared with the Plan tab's Approve plan. */
  planComment: PlanComment;
  tab: TaskTab;
  onTab: (tab: TaskTab) => void;
  onDelete: () => void;
}) {
  const error = action.error && <ErrorText>{action.error}</ErrorText>;

  if (task.status === "needs-you") {
    const copy = gateBanner(task, counts);
    return (
      <div className="flex flex-col gap-1.5 px-5 pt-3">
        <NeedsBanner
          title={copy.title}
          actions={
            <NeedsActions
              task={task}
              action={action}
              counts={counts}
              draft={draft}
              planComment={planComment}
              tab={tab}
              onTab={onTab}
            />
          }
        >
          {copy.detail}
        </NeedsBanner>
        {error}
      </div>
    );
  }

  if (ciNeedsYou(task) && task.ci) {
    const copy = ciBanner(task.ci);
    return (
      <div className="flex flex-col gap-1.5 px-5 pt-3">
        <NeedsBanner
          title={copy.title}
          actions={
            // The Finish tab has its own Fix CI next to the checks.
            tab === "finish" ? null : (
              <Button
                variant="needs"
                disabled={action.pending}
                onClick={() => void fixCi(action, task)}
              >
                Fix CI
              </Button>
            )
          }
        >
          {copy.detail}
        </NeedsBanner>
        {error}
      </div>
    );
  }

  if (task.status === "interrupted" || task.status === "failed") {
    const failed = task.status === "failed";
    const stoppedByUser = isStoppedByUser(task);
    const Icon = failed ? FailedIcon : stoppedByUser ? StopIcon : PausedIcon;
    return (
      <div className="flex flex-col gap-1.5 px-5 pt-3">
        <div
          role="status"
          className={cn(
            "flex flex-wrap items-start gap-3.5 rounded-lg border bg-sidebar px-4 py-3.5",
            failed ? "border-failed/45" : "border-interrupted/40",
          )}
        >
          <Icon size="lg" className={cn("mt-0.5", failed ? "text-failed" : "text-interrupted")} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="font-semibold text-foreground-strong">
              {failed ? "The task failed" : stoppedByUser ? "Stopped" : "Stopped mid-step"}
            </span>
            {stoppedByUser ? (
              <span className="text-[12.5px]">
                You stopped this task. The worktree is intact; Resume continues the agent&apos;s
                session where it stopped, or Delete removes the task.
              </span>
            ) : failed ? (
              <pre className="m-0 max-h-48 overflow-auto font-mono text-code whitespace-pre-wrap text-foreground">
                {task.error ?? "No error was recorded."}
              </pre>
            ) : task.error === IMPORT_INTERRUPTED_ERROR ? (
              <span className="text-[12.5px]">
                A data import found this task running or queued and stopped it. Resume continues it
                where it stopped.
              </span>
            ) : (
              <span className="text-[12.5px]">
                blackwall shut down while an agent was running. The worktree is intact; Resume
                continues the agent&apos;s session with its context.
              </span>
            )}
          </div>
          {stoppedByUser && deleteBlockedReason(task) === null && (
            <Button variant="ghost" className="hover:text-destructive" onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button
            variant="primary"
            disabled={action.pending}
            onClick={() => void resume(action, task)}
          >
            {failed ? "Retry" : "Resume"}
            <Kbd onFill>R</Kbd>
          </Button>
        </div>
        {error}
      </div>
    );
  }

  return error ? <div className="px-5 pt-3">{error}</div> : null;
}
