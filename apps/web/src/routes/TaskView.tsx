import type { DiffCommentInput, Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Tabs } from "radix-ui";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, commentOnDiff } from "../api";
import { EmptyState } from "../components/EmptyState";
import { CheckIcon, WarnIcon } from "../components/icons";
import { ArtifactsPanel } from "../components/task/ArtifactsPanel";
import { ChecksPanel } from "../components/task/ChecksPanel";
import { ContextPanel } from "../components/task/ContextPanel";
import { DiffPanel, DiffStat, type DiffDrafts } from "../components/task/DiffPanel";
import { FindingsPanel } from "../components/task/FindingsPanel";
import { FinishPanel } from "../components/task/FinishPanel";
import { GrillPanel } from "../components/task/GrillPanel";
import { OutputPanel } from "../components/task/OutputPanel";
import { approvePlan, resume, stop, type PlanComment } from "../components/task/actions";
import { DeleteTaskDialog } from "../components/task/DeleteTaskDialog";
import { PlanPanel } from "../components/task/PlanPanel";
import { TaskBanner } from "../components/task/TaskBanner";
import { TaskHeader } from "../components/task/TaskHeader";
import { useTaskAction } from "../components/task/use-task-action";
import { useTaskData, type TaskData } from "../components/task/use-task-data";
import { focusChat } from "../chat";
import { draftStamp, useDraft, type DraftCodec } from "../drafts";
import { uiStageIndex } from "../inbox";
import { isPlainKey, isTypingTarget, useEscapeTo, useWindowKeydown } from "../keyboard";
import { cn } from "../lib/utils";
import { queryKeys, reposQuery, taskQuery, taskWorktreeQuery } from "../query";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
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
  planApprovalComment,
  tabOnSignal,
  type TaskTab,
} from "../task-view";

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
    case "artifacts": {
      const n = data.artifacts.data?.length ?? 0;
      return n > 0 ? <Count>{n}</Count> : null;
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
 * resumes an interrupted or failed task, S stops a queued, running or waiting one.
 * Never while typing.
 */
function useTaskKeys(onKey: (key: "a" | "r" | "s") => void) {
  useWindowKeydown((event) => {
    if (!isPlainKey(event) || isTypingTarget(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "a" || key === "r" || key === "s") {
      event.preventDefault();
      onKey(key);
    }
  });
}

/** Shown when the task's worktree folder is gone, e.g. after an import on another machine. */
function MissingWorktreeNotice({ taskId }: { taskId: string }) {
  const worktree = useQuery(taskWorktreeQuery(taskId));
  if (!worktree.data?.path || worktree.data.exists) return null;
  return (
    <div className="px-5 pt-3">
      <div
        role="status"
        className="bw-chamfer flex items-start gap-3.5 bg-sidebar px-4 py-3.5 [--bw-chamfer-line:color-mix(in_oklab,var(--st-interrupted)_40%,transparent)]"
      >
        <WarnIcon size="lg" className="mt-0.5 text-interrupted" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="font-semibold text-foreground-strong">The worktree is missing</span>
          <span className="text-[12.5px]">
            Nothing is at <span className="mono break-all">{worktree.data.path}</span>, so the diff
            is empty and the task cannot resume. Recreate the worktree there, or delete the task.
          </span>
        </div>
      </div>
    </div>
  );
}

/** The plan approval comment as kept: `gate` ties it to the status, gate and plan it was written for. */
type PlanCommentDraft = PlanComment & { gate: string };

function parsePlanCommentDraft(raw: unknown, gate: string): PlanCommentDraft | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { enabled, body, gate: stored } = raw as Record<string, unknown>;
  if (typeof enabled !== "boolean" || typeof body !== "string" || stored !== gate) return undefined;
  return { enabled, body, gate };
}

/** Unsent hunk comments, with the branch head they were written against. */
interface DiffDraft {
  head: string | null;
  drafts: DiffDrafts;
}

const diffDraftCodec: DraftCodec<DiffDraft> = {
  empty: { head: null, drafts: {} },
  isEmpty: (v) => Object.values(v.drafts).every((d) => !d.trim()),
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return undefined;
    const { head, drafts } = raw as Record<string, unknown>;
    if (head !== null && typeof head !== "string") return undefined;
    if (typeof drafts !== "object" || drafts === null) return undefined;
    if (!Object.values(drafts).every((d) => typeof d === "string")) return undefined;
    return { head, drafts: drafts as DiffDrafts };
  },
};

function TaskScreen({ task }: { task: Task }) {
  const data = useTaskData(task);
  const action = useTaskAction(task);
  const [tab, setTab] = useState<TaskTab>(() => defaultTab(task));
  const [deleting, setDeleting] = useState(false);
  // Opt-in, so it starts unticked each time the task reaches plan approval. An edited comment
  // is kept as a draft for this gate and plan, and comes back when the user returns to it.
  const planGate = `${task.status}:${task.gate}:${draftStamp(task.plan ?? "")}`;
  const defaultPlanBody = planApprovalComment(task);
  const freshPlanComment = (): PlanCommentDraft => ({
    enabled: false,
    body: defaultPlanBody,
    gate: planGate,
  });
  const [planComment, setPlanComment] = useDraft<PlanCommentDraft>(`task:${task.id}:plan-comment`, {
    empty: freshPlanComment(),
    isEmpty: (c) => !c.enabled && c.body === defaultPlanBody,
    parse: (raw) => parsePlanCommentDraft(raw, planGate),
  });
  const onPlanComment = (c: PlanComment) => setPlanComment({ ...c, gate: planGate });

  // A new gate or status opens the tab where the user is needed (or the work is),
  // except that a review task stepping through its diff stays there, and a user on
  // Grill whose answers send the task back to work stays there (Agent output flashes).
  // Plain values, not updaters, keep these render-time updates idempotent.
  const signal = `${task.status}:${task.gate}`;
  const [seenSignal, setSeenSignal] = useState(signal);
  const [seenGate, setSeenGate] = useState(task.gate);
  const [holdingGrill, setHoldingGrill] = useState(false);
  const [outputFlash, setOutputFlash] = useState(0);
  if (seenSignal !== signal) {
    setSeenSignal(signal);
    const next = tabOnSignal(task, { previousGate: seenGate, holdingGrill, tab });
    setTab(next.tab);
    setHoldingGrill(next.holdingGrill);
    if (next.flash) setOutputFlash(outputFlash + 1);
    setSeenGate(task.gate);
    setPlanComment(freshPlanComment());
  }
  const chooseTab = (next: TaskTab) => {
    setTab(next);
    setHoldingGrill(false);
  };
  const current = isTabEnabled(task, tab) ? tab : defaultTab(task);

  // Unsent hunk comments survive navigation and reloads, but not new commits on the branch.
  const [diffDraft, setDiffDraft, clearDiffDraft] = useDraft<DiffDraft>(
    `task:${task.id}:diff`,
    diffDraftCodec,
  );
  const branchHead = data.branchDiff.data?.to ?? null;
  if (branchHead !== null && diffDraft.head !== null && diffDraft.head !== branchHead) {
    clearDiffDraft();
  } else if (branchHead !== null && diffDraft.head === null && !diffDraftCodec.isEmpty(diffDraft)) {
    setDiffDraft({ head: branchHead, drafts: diffDraft.drafts });
  }

  async function sendDiffComments(comments: DiffCommentInput[]): Promise<boolean> {
    const sent = await action.run(
      "Send comments",
      async () => (await commentOnDiff(task.id, comments)).task,
    );
    if (!sent) return false;
    clearDiffDraft();
    return true;
  }

  const openQuestions = openQuestionCount(data.questions.data ?? []);
  const counts = {
    openQuestions,
    blocking: data.visibleFindings.filter(isBlocking).length,
    round: data.round,
  };

  useTaskKeys((key) => {
    if (action.pending) return;
    const atApproval = task.status === "needs-you" && task.gate === "plan-approval";
    if (key === "a" && atApproval) {
      void approvePlan(action, task, planComment);
    } else if (key === "r" && atApproval) {
      chooseTab("plan");
      focusChat();
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
            openQuestions={openQuestions}
            comment={planComment}
            onComment={onPlanComment}
            className="flex-1"
          />
        );
      case "grill":
        return (
          <GrillPanel
            task={task}
            questions={data.questions.data ?? []}
            steps={data.steps}
            action={action}
            planComment={planComment}
            onPlanComment={onPlanComment}
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
        return <FindingsPanel task={task} findings={data.visibleFindings} steps={data.steps} />;
      case "diff":
        return (
          <DiffPanel
            task={task}
            diffs={data.diffs.data ?? []}
            loading={data.diffs.isPending}
            branchDiff={data.branchDiff.data}
            findings={data.visibleFindings}
            drafts={diffDraft.drafts}
            onDraftsChange={(drafts) => setDiffDraft({ head: branchHead, drafts })}
            onSend={sendDiffComments}
            action={action}
          />
        );
      case "artifacts":
        return <ArtifactsPanel task={task} />;
      case "checks":
        return (
          <ChecksPanel
            step={data.checksStep}
            checks={data.checks}
            skipReason={data.checksSkipReason}
            loading={data.checksQuery.isPending}
          />
        );
      case "finish":
        return <FinishPanel task={task} data={data} action={action} />;
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <TaskHeader
        task={task}
        round={data.round}
        steps={data.steps}
        action={action}
        onDelete={() => setDeleting(true)}
      />
      <MissingWorktreeNotice taskId={task.id} />
      <TaskBanner
        task={task}
        action={action}
        counts={counts}
        planComment={planComment}
        tab={current}
        onTab={chooseTab}
        onDelete={() => setDeleting(true)}
      />
      <Tabs.Root
        value={current}
        onValueChange={(value) => chooseTab(value as TaskTab)}
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
                "data-[state=active]:text-foreground-strong data-[state=active]:after:absolute data-[state=active]:after:right-2 data-[state=active]:after:-bottom-px data-[state=active]:after:left-2 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-primary data-[state=active]:after:shadow-glow-tab data-[state=active]:after:content-['']",
              )}
            >
              {TAB_LABELS[name]}
              <TabDecoration tab={name} task={task} data={data} />
              {name === "output" && outputFlash > 0 && (
                <span key={`flash:${outputFlash}`} aria-hidden="true" className="bw-tab-flash" />
              )}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={current} className="flex min-h-0 flex-1 flex-col focus:outline-none">
          {panel(current)}
        </Tabs.Content>
      </Tabs.Root>
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

/** Escape leaves the task for the selected repo's backlog, or home when none is selected. */
function useEscapeToBacklog() {
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const repoId = resolveSelectedRepo(useSelectedRepoId(), repos.data)?.id;
  useEscapeTo(() => {
    void (repoId
      ? navigate({ to: "/repos/$repoId/backlog", params: { repoId } })
      : navigate({ to: "/" }));
  });
}

/** Main pane for one task: header, needs-you banner and the section tabs. */
export function TaskView({ taskId }: { taskId: string }) {
  const task = useQuery(taskQuery(taskId));
  useLeaveWhenDeleted(taskId);
  useEscapeToBacklog();

  if (task.isPending) {
    return <EmptyState key="loading" role="status" className="h-full" title="Pulling the task…" />;
  }
  if (task.isError) {
    return task.error instanceof ApiError && task.error.status === 404 ? (
      <EmptyState key="not-found" className="h-full" title="Task not found">
        It may have been deleted.
      </EmptyState>
    ) : (
      <EmptyState key="error" role="alert" className="h-full" title="Could not load the task">
        {task.error.message}
      </EmptyState>
    );
  }
  return <TaskScreen task={task.data} />;
}
