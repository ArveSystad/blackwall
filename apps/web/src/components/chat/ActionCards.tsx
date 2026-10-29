import type { ChatAction, ChatState, Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { answerQuestion, createBacklogItem, markChatActionApplied } from "../../api";
import {
  actionAvailability,
  chatActionSummary,
  chatActionTask,
  type ChatActionAvailability,
  type ChatActionSummary,
} from "../../chat";
import { cn } from "../../lib/utils";
import { queryKeys, taskGrillQuery } from "../../query";
import { errorMessage } from "../../settings-forms";
import { GATE_REASONS } from "../../task-view";
import { CheckIcon } from "../icons";
import { Markdown } from "../Markdown";
import { StatusBadge } from "../StatusBadge";
import { answerGate, messageRoute, resume, stop } from "../task/actions";
import { useTaskAction } from "../task/use-task-action";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";

/** Longer create-task descriptions start clamped, with Show more. */
const LONG_DESCRIPTION_CHARS = 280;

/**
 * A proposed action: what Apply does, then Apply. Applying runs the action through its existing
 * endpoint, then marks it applied on the server so it stays Done. If only the mark failed, Retry
 * repeats the mark and never the action.
 */
export function ActionCard({
  action,
  repoId,
  taskId,
  tasks,
  needs,
}: {
  action: ChatAction;
  repoId: string;
  /** The conversation's task; undefined for the repo chat. */
  taskId: string | undefined;
  tasks: readonly Task[];
  needs: boolean;
}) {
  const task = chatActionTask(action, tasks, repoId);
  const availability = actionAvailability(action, tasks, repoId);
  const summary = chatActionSummary(action, task);
  if (action.kind === "create-task") {
    return (
      <CreateTaskCard
        action={action}
        repoId={repoId}
        chatTaskId={taskId}
        summary={summary}
        availability={availability}
      />
    );
  }
  if (!task) {
    return (
      <CardShell
        summary={summary}
        title={<span className="mono text-muted-foreground">{summary.title}</span>}
        availability={availability}
        apply={{ variant: "default", pending: false, error: null, run: async () => false }}
        repoId={repoId}
        chatTaskId={taskId}
        actionId={action.id}
      />
    );
  }
  return (
    <TaskActionCard
      action={action}
      task={task}
      repoId={repoId}
      chatTaskId={taskId}
      summary={summary}
      availability={availability}
      needs={needs}
    />
  );
}

type TaskChatAction = Exclude<ChatAction, { kind: "create-task" }>;

function TaskActionCard({
  action,
  task,
  repoId,
  chatTaskId,
  summary,
  availability,
  needs,
}: {
  action: TaskChatAction;
  task: Task;
  repoId: string;
  chatTaskId: string | undefined;
  summary: ChatActionSummary;
  availability: ChatActionAvailability;
  needs: boolean;
}) {
  const queryClient = useQueryClient();
  const taskAction = useTaskAction(task);
  const grill = useQuery({
    ...taskGrillQuery(task.id),
    enabled: action.kind === "answer-question",
  });
  const question =
    action.kind === "answer-question"
      ? grill.data?.find((q) => q.id === action.questionId)
      : undefined;
  const answered =
    question && question.answer !== null && availability.kind === "available"
      ? ({ kind: "unavailable", reason: "This question is already answered" } as const)
      : undefined;

  async function run(): Promise<boolean> {
    switch (action.kind) {
      case "answer-question": {
        const done = await taskAction.run(
          "Answer question",
          async () => (await answerQuestion(task.id, action.questionId, action.answer)).task,
        );
        if (done) void queryClient.invalidateQueries({ queryKey: queryKeys.taskGrill(task.id) });
        return done !== undefined;
      }
      case "message-task": {
        const route = messageRoute(task);
        if (!route) return false;
        const done = await answerGate(
          taskAction,
          task,
          { decision: route.decision, message: action.message },
          route.send,
        );
        return done !== undefined;
      }
      case "stop-task":
        return (await stop(taskAction, task)) !== undefined;
      case "resume-task":
        return (await resume(taskAction, task, action.message)) !== undefined;
    }
  }

  const variant =
    action.kind === "stop-task"
      ? "destructive-ghost"
      : (action.kind === "message-task" || action.kind === "answer-question") && needs
        ? "needs"
        : "default";

  return (
    <CardShell
      summary={summary}
      title={
        <Link
          to="/tasks/$taskId"
          params={{ taskId: task.id }}
          className="min-w-0 font-semibold break-words text-foreground-strong"
        >
          {task.title}
        </Link>
      }
      badges={
        <>
          <StatusBadge status={task.status} />
          {(action.kind === "message-task" || action.kind === "answer-question") && task.gate && (
            <span className="text-meta text-needs">{GATE_REASONS[task.gate]}</span>
          )}
        </>
      }
      detail={
        (question || summary.detail) && (
          <>
            {question && (
              <p className="m-0 text-meta break-words whitespace-pre-wrap text-muted-foreground">
                {question.question}
              </p>
            )}
            {summary.detail && (
              <p className="m-0 text-body break-words whitespace-pre-wrap text-foreground">
                {summary.detail}
              </p>
            )}
          </>
        )
      }
      availability={answered ?? availability}
      apply={{ variant, pending: taskAction.pending, error: taskAction.error, run }}
      repoId={repoId}
      chatTaskId={chatTaskId}
      actionId={action.id}
    />
  );
}

function CreateTaskCard({
  action,
  repoId,
  chatTaskId,
  summary,
  availability,
}: {
  action: Extract<ChatAction, { kind: "create-task" }>;
  repoId: string;
  chatTaskId: string | undefined;
  summary: ChatActionSummary;
  availability: ChatActionAvailability;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const long = action.description.length > LONG_DESCRIPTION_CHARS;

  async function run(): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await createBacklogItem(repoId, {
        origin: { kind: "free-text" },
        title: action.title,
        freeText: action.description,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <CardShell
      summary={summary}
      title={
        <span className="min-w-0 font-semibold break-words text-foreground-strong">
          {action.title}
        </span>
      }
      detail={
        <div className="flex flex-col items-start gap-1">
          <div className={cn("w-full", !expanded && "line-clamp-4")}>
            <Markdown className="break-words">{action.description}</Markdown>
          </div>
          {long && (
            <button
              type="button"
              aria-expanded={expanded}
              className="cursor-pointer bg-transparent p-0 text-meta text-primary hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      }
      availability={availability}
      apply={{ variant: "default", pending, error, run }}
      repoId={repoId}
      chatTaskId={chatTaskId}
      actionId={action.id}
    />
  );
}

/** How a card applies its action; `run` resolves true when the action succeeded. */
interface ApplyAction {
  variant: "default" | "needs" | "destructive-ghost";
  pending: boolean;
  error: string | null;
  run: () => Promise<boolean>;
}

function CardShell({
  summary,
  title,
  badges,
  detail,
  availability,
  apply,
  repoId,
  chatTaskId,
  actionId,
}: {
  summary: ChatActionSummary;
  title: ReactNode;
  badges?: ReactNode;
  detail?: ReactNode;
  availability: ChatActionAvailability;
  apply: ApplyAction;
  repoId: string;
  /** The task whose conversation holds the action; undefined for the repo chat. */
  chatTaskId: string | undefined;
  actionId: string;
}) {
  const queryClient = useQueryClient();
  /** The action ran but the mark has not stuck yet: Retry repeats only the mark. */
  const [ran, setRan] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  async function mark() {
    setMarking(true);
    setMarkError(null);
    try {
      const next = await markChatActionApplied(repoId, actionId, chatTaskId);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repoId, chatTaskId), next);
    } catch (cause) {
      setMarkError(errorMessage(cause));
    } finally {
      setMarking(false);
    }
  }

  async function onApply() {
    if (ran) return mark();
    if (!(await apply.run())) return;
    setRan(true);
    await mark();
  }

  const pending = apply.pending || marking;
  const unavailable = availability.kind === "unavailable" && !ran ? availability.reason : null;
  const error = markError ?? (ran ? null : apply.error);

  return (
    <div className="bw-chamfer flex flex-col gap-2.5 bg-card p-3 [--bw-chamfer-line:var(--border)]">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-meta text-muted-foreground">{summary.label}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {title}
          {badges}
        </div>
        {detail}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {availability.kind === "applied" ? (
          <span className="inline-flex items-center gap-1.5 text-meta font-medium text-done">
            <CheckIcon size="sm" />
            Done
          </span>
        ) : (
          <>
            <Button
              size="sm"
              variant={apply.variant}
              disabled={pending || unavailable !== null}
              aria-label={`${ran ? "Retry" : "Apply"}: ${summary.label} ${summary.title}`}
              onClick={() => void onApply()}
            >
              {pending ? "Applying…" : ran ? "Retry" : "Apply"}
            </Button>
            {unavailable && <span className="text-meta text-muted-foreground">{unavailable}</span>}
          </>
        )}
      </div>
      {error && availability.kind !== "applied" && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
