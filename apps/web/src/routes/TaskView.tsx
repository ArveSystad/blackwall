import type { Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { CheckIcon, WallIcon } from "../components/icons";
import { ChecksPanel } from "../components/task/ChecksPanel";
import { ContextPanel } from "../components/task/ContextPanel";
import { DiffPanel, DiffStat } from "../components/task/DiffPanel";
import { FindingsPanel } from "../components/task/FindingsPanel";
import { FinishPanel } from "../components/task/FinishPanel";
import { GrillPanel } from "../components/task/GrillPanel";
import { InputBar } from "../components/task/InputBar";
import { OutputPanel } from "../components/task/OutputPanel";
import { answerGate, focusInputBar, resume, stop } from "../components/task/actions";
import { DeleteTaskDialog } from "../components/task/DeleteTaskDialog";
import { PlanPanel } from "../components/task/PlanPanel";
import { TaskBanner } from "../components/task/TaskBanner";
import { TaskHeader } from "../components/task/TaskHeader";
import { useTaskAction } from "../components/task/use-task-action";
import { useTaskData, type TaskData } from "../components/task/use-task-data";
import { uiStageIndex } from "../inbox";
import { isPlainKey, isTypingTarget } from "../keyboard";
import { cn } from "../lib/utils";
import { queryKeys, taskQuery } from "../query";
import {
  TAB_LABELS,
  TASK_TABS,
  canStop,
  checkPassed,
  defaultTab,
  diffStat,
  isBlocking,
  isTabEnabled,
  openQuestionCount,
  parseDiff,
  type TaskTab,
} from "../task-view";

function Centered({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <WallIcon className="size-7 text-faint" />
      <span className="font-medium text-foreground-strong">{title}</span>
      {detail && <span className="text-meta text-muted-foreground">{detail}</span>}
    </div>
  );
}

function Count({ children, needs = false }: { children: ReactNode; needs?: boolean }) {
  return (
    <span className={cn("mono text-[11px] text-faint", needs && "font-semibold text-magenta")}>
      {children}
    </span>
  );
}

/** What each tab shows beside its label: counts in mono, needs-you counts in magenta. */
function TabDecoration({ tab, task, data }: { tab: TaskTab; task: Task; data: TaskData }) {
  switch (tab) {
    case "plan":
      return task.plan && uiStageIndex(task) >= 2 ? (
        <CheckIcon size="sm" className="text-done" aria-label="approved" role="img" />
      ) : null;
    case "grill": {
      const questions = data.questions.data ?? [];
      if (questions.length === 0) return null;
      const open = openQuestionCount(questions);
      return <Count needs={open > 0}>{open > 0 ? open : questions.length}</Count>;
    }
    case "output":
      return task.status === "running" ? (
        <span
          aria-label="live"
          role="img"
          className="size-1.5 animate-pulse-running rounded-full bg-running shadow-glow-cyan"
        />
      ) : null;
    case "findings": {
      const active = data.visibleFindings.filter((f) => f.status !== "fixed");
      if (active.length === 0) return null;
      const blocking = active.filter(isBlocking).length;
      return <Count needs={task.status === "needs-you" && blocking > 0}>{active.length}</Count>;
    }
    case "diff": {
      const diffs = data.diffs.data ?? [];
      if (diffs.length === 0) return null;
      return <DiffStat {...diffStat(diffs.flatMap((d) => parseDiff(d.diff)))} />;
    }
    case "checks": {
      if (data.checks.length === 0) return null;
      const passed = data.checks.filter(checkPassed).length;
      return (
        <span
          className={cn(
            "mono text-[11px]",
            passed === data.checks.length ? "text-done" : "text-failed",
          )}
        >
          {passed}/{data.checks.length}
        </span>
      );
    }
    default:
      return null;
  }
}

/**
 * Task keys: A approves the plan, R requests changes (at plan approval) or
 * resumes an interrupted or failed task, S stops a queued or running one.
 * Never while typing.
 */
function useTaskKeys(task: Task, onKey: (key: "a" | "r" | "s") => void) {
  const handler = useRef(onKey);
  useEffect(() => {
    handler.current = onKey;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPlainKey(event) || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "a" || key === "r" || key === "s") {
        event.preventDefault();
        handler.current(key);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [task.id]);
}

function TaskScreen({ task }: { task: Task }) {
  const data = useTaskData(task);
  const action = useTaskAction(task);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<TaskTab>(() => defaultTab(task));
  const [deleting, setDeleting] = useState(false);

  // A new gate or status opens the tab where the user is needed (or the work is).
  const signal = `${task.status}:${task.gate}`;
  const [seenSignal, setSeenSignal] = useState(signal);
  if (seenSignal !== signal) {
    setSeenSignal(signal);
    setTab(defaultTab(task));
  }
  const current = isTabEnabled(task, tab) ? tab : defaultTab(task);

  const openQuestions = openQuestionCount(data.questions.data ?? []);
  const counts = {
    openQuestions,
    blocking: data.visibleFindings.filter(isBlocking).length,
    round: data.round,
  };

  useTaskKeys(task, (key) => {
    if (action.pending) return;
    const atApproval = task.status === "needs-you" && task.gate === "plan-approval";
    if (key === "a" && atApproval) {
      void answerGate(action, task, { decision: "approve" }, "Approve plan");
    } else if (key === "r" && atApproval) {
      setTab("plan");
      focusInputBar();
    } else if (key === "r" && (task.status === "interrupted" || task.status === "failed")) {
      void resume(action, task);
    } else if (key === "s" && canStop(task)) {
      void stop(action, task);
    }
  });

  function panel(name: TaskTab): ReactNode {
    switch (name) {
      case "context":
        return (
          <div className="min-h-0 flex-1 overflow-auto">
            <ContextPanel task={task} />
          </div>
        );
      case "plan":
        return (
          <PlanPanel
            task={task}
            action={action}
            draft={draft}
            openQuestions={openQuestions}
            className="flex-1"
          />
        );
      case "grill":
        return (
          <GrillPanel
            task={task}
            questions={data.questions.data ?? []}
            action={action}
            draft={draft}
          />
        );
      case "output":
        return (
          <OutputPanel
            taskId={task.id}
            steps={data.steps}
            loading={
              data.runs.isPending || (data.latestRun !== undefined && data.stepsQuery.isPending)
            }
          />
        );
      case "findings":
        return <FindingsPanel task={task} findings={data.visibleFindings} />;
      case "diff":
        return <DiffPanel diffs={data.diffs.data ?? []} loading={data.diffs.isPending} />;
      case "checks":
        return (
          <ChecksPanel
            step={data.checksStep}
            checks={data.checks}
            loading={data.checksQuery.isPending}
          />
        );
      case "finish":
        return <FinishPanel task={task} data={data} action={action} draft={draft} />;
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TaskHeader
        task={task}
        round={data.round}
        action={action}
        onDelete={() => setDeleting(true)}
      />
      <TaskBanner
        task={task}
        action={action}
        counts={counts}
        draft={draft}
        tab={current}
        onTab={setTab}
        onDelete={() => setDeleting(true)}
      />
      <Tabs.Root
        value={current}
        onValueChange={(value) => setTab(value as TaskTab)}
        className="mt-2 flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label="Task sections"
          className="flex flex-none items-stretch gap-0.5 overflow-x-auto border-b border-border px-4"
        >
          {TASK_TABS.map((name) => (
            <Tabs.Trigger
              key={name}
              value={name}
              disabled={!isTabEnabled(task, name)}
              className={cn(
                "relative inline-flex h-9 cursor-pointer items-center gap-1.5 bg-transparent px-2.5 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground hover:text-foreground-strong focus-visible:shadow-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
                "data-[state=active]:text-foreground-strong data-[state=active]:after:absolute data-[state=active]:after:right-2 data-[state=active]:after:-bottom-px data-[state=active]:after:left-2 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-[2px] data-[state=active]:after:bg-primary data-[state=active]:after:shadow-glow-tab data-[state=active]:after:content-['']",
              )}
            >
              {TAB_LABELS[name]}
              <TabDecoration tab={name} task={task} data={data} />
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={current} className="flex min-h-0 flex-1 flex-col focus:outline-none">
          {panel(current)}
        </Tabs.Content>
      </Tabs.Root>
      <InputBar task={task} action={action} draft={draft} onDraft={setDraft} />
      {deleting && <DeleteTaskDialog task={task} onClose={() => setDeleting(false)} />}
    </div>
  );
}

/** Returns to the inbox once the task is deleted, here or anywhere else. */
function useLeaveWhenDeleted(taskId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const key = JSON.stringify(queryKeys.task(taskId));
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed" && JSON.stringify(event.query.queryKey) === key) {
        void navigate({ to: "/" });
      }
    });
  }, [queryClient, navigate, taskId]);
}

/** Main pane for one task: header, needs-you banner, the section tabs and the input bar. */
export function TaskView({ taskId }: { taskId: string }) {
  const task = useQuery(taskQuery(taskId));
  useLeaveWhenDeleted(taskId);

  if (task.isPending) return <Centered title="Loading task…" />;
  if (task.isError) {
    return task.error instanceof ApiError && task.error.status === 404 ? (
      <Centered title="Task not found" detail="It may have been deleted." />
    ) : (
      <Centered title="Could not load the task" detail={task.error.message} />
    );
  }
  return <TaskScreen task={task.data} />;
}
