import type { Task } from "@blackwall/shared";
import { deleteBlockedReason, gateBanner, isStoppedByUser, type TaskTab } from "../../task-view";
import { FailedIcon, PausedIcon, StopIcon } from "../icons";
import { NeedsBanner } from "../NeedsBanner";
import { ErrorText } from "../settings/parts";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { answerGate, resume } from "./actions";
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
  tab,
  onTab,
}: {
  task: Task;
  action: TaskAction;
  counts: BannerCounts;
  draft: string;
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
            onClick={() => void answerGate(action, task, { decision: "approve" }, "Approve plan")}
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

/** Needs-you banner, or the interrupted / failed card with Resume. Nothing for other states. */
export function TaskBanner({
  task,
  action,
  counts,
  draft,
  tab,
  onTab,
  onDelete,
}: {
  task: Task;
  action: TaskAction;
  counts: BannerCounts;
  draft: string;
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

  if (task.status === "interrupted" || task.status === "failed") {
    const failed = task.status === "failed";
    const stoppedByUser = isStoppedByUser(task);
    const Icon = failed ? FailedIcon : stoppedByUser ? StopIcon : PausedIcon;
    return (
      <div className="flex flex-col gap-1.5 px-5 pt-3">
        <div
          role="status"
          className={
            failed
              ? "flex flex-wrap items-start gap-3.5 rounded-lg border border-failed/45 bg-sidebar px-4 py-3.5"
              : "flex flex-wrap items-start gap-3.5 rounded-lg border border-interrupted/40 bg-sidebar px-4 py-3.5"
          }
        >
          <Icon size="lg" className={failed ? "mt-0.5 text-failed" : "mt-0.5 text-interrupted"} />
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
