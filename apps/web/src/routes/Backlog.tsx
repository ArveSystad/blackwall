import {
  AGENT_ROLES,
  type BacklogItemView,
  type RepoIssue,
  type RepoJiraIssue,
  type RepoSync,
  type RoleAgents,
  type Task,
  type TaskOrigin,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  MissingCredentialError,
  archiveTask,
  createBacklogItem,
  createTask,
  deleteBacklogItem,
  pushRepo,
  reorderBacklog,
  resumeBacklogRunner,
  runBacklogItem,
  setBacklogRunner,
  unarchiveTask,
  updateBacklogItem,
} from "../api";
import {
  PUSHED_NOTE_MS,
  backlogSections,
  itemState,
  moveItem,
  nextBacklogItem,
  pendingCount,
  plural,
  reorderIds,
  rowAction,
  runnerStatus,
  syncControl,
  type BacklogItemState,
  type RunnerStatus,
} from "../backlog";
import {
  issueOrigin,
  issueWork,
  jiraIssueOrigin,
  jiraIssueWork,
  type IssueWork,
} from "../assigned-issues";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { EmptyState } from "../components/EmptyState";
import { IssueRow, IssueWorkLink, JiraIssueRow } from "../components/IssueRow";
import {
  BacklogIcon,
  FailedIcon,
  GripIcon,
  PausedIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
} from "../components/icons";
import { NewTaskModal } from "../components/NewTaskModal";
import { ORIGIN_ICONS } from "../components/origins";
import { Section } from "../components/Section";
import { StatusBadge, pill } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { ErrorText } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { useWithCredential } from "../credentials";
import { useNow } from "../hooks";
import { useEscapeTo } from "../keyboard";
import { matchesFilter, originKey, stackLabel, statusLabel } from "../inbox";
import { cn } from "../lib/utils";
import {
  backlogQuery,
  backlogRunnerQuery,
  issuesRefreshSeconds,
  queryKeys,
  quotaQuery,
  repoIssuesQuery,
  repoJiraIssuesQuery,
  repoSyncQuery,
  reposQuery,
  roleDefaultsQuery,
  settingsQuery,
  tasksQuery,
} from "../query";
import { setSelectedRepo } from "../selected-repo";
import { errorMessage } from "../settings-forms";
import { backlogAgentClis } from "../task-view";

/** An item's role agents with the role defaults filled in, as the server resolves them. */
function resolvedRoles(agents: RoleAgents, defaults: RoleAgents): RoleAgents {
  const roles: RoleAgents = { ...defaults };
  for (const role of AGENT_ROLES) {
    if (agents[role] !== undefined) Object.assign(roles, { [role]: agents[role] });
  }
  return roles;
}

const RUNNER_TONES: Record<RunnerStatus["tone"], { text: string; dot: string }> = {
  off: { text: "text-faint", dot: "bg-faint" },
  idle: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
  ready: { text: "text-running", dot: "bg-running" },
  waiting: { text: "text-interrupted", dot: "bg-interrupted" },
  paused: { text: "text-interrupted", dot: "bg-interrupted" },
  halted: { text: "text-failed", dot: "bg-failed" },
};

/**
 * Says why the runner is or isn't promoting something; switches it, its
 * remote issues and autonomous mode per repo (autonomy only after a
 * confirmation) and resumes a halt.
 */
function RunnerBar({
  repoId,
  status,
  enabled,
  autonomous,
  defaultBranch,
  globalOn,
  includeRemoteIssues,
  hasRemoteIssues,
}: {
  repoId: string;
  status: RunnerStatus | null;
  enabled: boolean | undefined;
  autonomous: boolean | undefined;
  /** The repo's default branch, named in the autonomy confirmation. */
  defaultBranch: string;
  globalOn: boolean;
  includeRemoteIssues: boolean | undefined;
  /** The repo has open GitHub issues listed; the switch shows only then, or while on. */
  hasRemoteIssues: boolean;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function act(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlogRunner(repoId) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const tone = status ? RUNNER_TONES[status.tone] : RUNNER_TONES.idle;
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-sidebar px-5 py-2 text-body"
      aria-label="Backlog runner"
      role="region"
    >
      <span className="label text-foreground">Runner</span>
      {status ? (
        <span className="flex min-w-0 flex-1 items-center gap-2" role="status">
          {status.tone === "paused" ? (
            <PausedIcon size="sm" className={tone.text} />
          ) : status.tone === "halted" ? (
            <FailedIcon size="sm" className={tone.text} />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 flex-none rounded-full",
                tone.dot,
                status.tone === "ready" && "animate-pulse-running",
              )}
            />
          )}
          <span className={cn("font-semibold", tone.text)}>{status.label}</span>
          <span className="truncate text-foreground">{status.detail}</span>
          {autonomous && (
            <span className="font-semibold whitespace-nowrap text-magenta">
              Autonomous · local only
            </span>
          )}
          {status.haltedTaskId && (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: status.haltedTaskId }}
              className="text-body whitespace-nowrap"
            >
              Open task
            </Link>
          )}
        </span>
      ) : (
        <span className="flex-1 text-foreground">Loading…</span>
      )}
      {error && <ErrorText className="text-body">{error}</ErrorText>}
      {status?.tone === "halted" && (
        <Button
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={() => void act(() => resumeBacklogRunner(repoId))}
        >
          Resume
        </Button>
      )}
      {enabled !== undefined && (
        <label
          className={cn(
            "bw-chamfer bw-chamfer-pill bw-chamfer-has-focus inline-flex h-6 cursor-pointer items-center gap-1.5 px-1.5 text-body text-foreground",
            !globalOn && "opacity-60",
          )}
          title={globalOn ? undefined : "The runner is off for every repo in Settings"}
        >
          <input
            type="checkbox"
            className="focus:outline-none"
            checked={enabled}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked;
              void act(() => setBacklogRunner(repoId, { enabled: next }));
            }}
          />
          Run this repo&apos;s backlog
        </label>
      )}
      {enabled && includeRemoteIssues !== undefined && (hasRemoteIssues || includeRemoteIssues) && (
        <label
          className="bw-chamfer bw-chamfer-pill bw-chamfer-has-focus inline-flex h-6 cursor-pointer items-center gap-1.5 px-1.5 text-body text-foreground"
          title="When the queue is empty, the runner starts this repo's open GitHub issues that are unassigned or assigned to you, one at a time. Pause an imported item to skip its issue."
        >
          <span aria-hidden="true" className="text-faint">
            ↳
          </span>
          <input
            type="checkbox"
            className="focus:outline-none"
            checked={includeRemoteIssues}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked;
              void act(() => setBacklogRunner(repoId, { includeRemoteIssues: next }));
            }}
          />
          Include remote issues
        </label>
      )}
      {autonomous !== undefined && (
        <label
          className="bw-chamfer bw-chamfer-pill bw-chamfer-has-focus inline-flex h-6 cursor-pointer items-center gap-1.5 px-1.5 text-body text-foreground"
          title="Agents make every decision for this repo's backlog tasks; local only"
        >
          <input
            type="checkbox"
            className="focus:outline-none"
            checked={autonomous}
            disabled={pending}
            onChange={(event) => {
              // Switching on asks first; switching off applies at once.
              if (event.target.checked) setConfirming(true);
              else void act(() => setBacklogRunner(repoId, { autonomous: false }));
            }}
          />
          Autonomous
        </label>
      )}
      {confirming && (
        <ConfirmDialog
          title="Go autonomous"
          confirmLabel="Go autonomous"
          confirmVariant="destructive"
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await setBacklogRunner(repoId, { autonomous: true });
            await queryClient.invalidateQueries({ queryKey: queryKeys.backlogRunner(repoId) });
          }}
        >
          Agents will answer their own questions, approve plans and triage, merge finished work into
          the local {defaultBranch} and create follow-up tasks, with no review.{" "}
          <strong>Local only:</strong> it never pushes branches, opens pull requests or posts
          anywhere, because PRs and their reviews would stop the autonomy. Local {defaultBranch}{" "}
          will get ahead of origin until you push. Escalations, and tasks whose only finish is
          outbound (issue, Jira or PR origins), still wait for you.
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * Bottom bar of the backlog view: how many tasks are archived, a toggle that
 * lists them, and a bulk action that archives every done task still listed.
 */
function ArchiveBar({
  archived,
  archivable,
  shown,
  onToggle,
}: {
  archived: number;
  /** Done tasks not archived yet. */
  archivable: readonly Task[];
  shown: boolean;
  onToggle: () => void;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archiveDone() {
    setPending(true);
    setError(null);
    const results = await Promise.allSettled(archivable.map((task) => archiveTask(task.id)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      setError(
        `Archived ${results.length - failed.length} of ${results.length}: ${errorMessage(failed[0]!.reason)}`,
      );
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
    setPending(false);
  }

  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border bg-sidebar px-5 py-2 text-body"
      aria-label="Archive"
      role="region"
    >
      <span className="label text-foreground">Archive</span>
      <span className="mono flex-1 text-[12.5px] text-muted-foreground">{archived} archived</span>
      {error && <ErrorText className="text-body">{error}</ErrorText>}
      <Button size="sm" variant="ghost" aria-expanded={shown} onClick={onToggle}>
        {shown ? "Hide archive" : `Show archive (${archived})`}
      </Button>
      <Button
        size="sm"
        disabled={pending || archivable.length === 0}
        onClick={() => void archiveDone()}
        title="Move every done task to the archive"
      >
        Archive done ({archivable.length})
      </Button>
    </div>
  );
}

function StateChip({ state }: { state: BacklogItemState }) {
  switch (state.kind) {
    case "next":
      return (
        <span className={cn(pill, "bg-running/12 text-running")}>
          <span className="size-1.5 rounded-full bg-running" aria-hidden="true" />
          Next up
        </span>
      );
    case "waiting":
      return <span className="text-label whitespace-nowrap text-muted-foreground">Waiting</span>;
    case "paused":
      return (
        <span className={cn(pill, "gap-1 bg-interrupted/12 text-interrupted")}>
          <PausedIcon size="sm" />
          Paused
        </span>
      );
    case "blocked":
      return (
        <span className="max-w-60 truncate text-label text-muted-foreground">
          Blocked by {state.by.join(", ")}
        </span>
      );
    case "promoted":
      return state.task ? (
        <Link
          to="/tasks/$taskId"
          params={{ taskId: state.task.id }}
          className="inline-flex items-center gap-1.5 text-label whitespace-nowrap no-underline hover:no-underline"
        >
          <span className="text-muted-foreground">Promoted →</span>
          <StatusBadge status={state.task.status} label={statusLabel(state.task)} />
        </Link>
      ) : (
        <span className="text-label whitespace-nowrap text-faint">Promoted · task removed</span>
      );
  }
}

function BacklogRow({
  item,
  state,
  dependsOn,
  sourceTask,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onFocusStep,
  onOpen,
  onEdit,
  onRun,
  running,
  onTogglePause,
  onDelete,
  onArchive,
}: {
  item: BacklogItemView;
  state: BacklogItemState;
  /** Titles of the items it depends on. */
  dependsOn: string[];
  /** Title of the task that proposed this follow-up, once tasks have loaded. */
  sourceTask: string | undefined;
  dragging: BacklogItemView | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onMove: (delta: -1 | 1) => void;
  onFocusStep: (delta: -1 | 1) => void;
  /** What a click or Enter on the row does; none for a promoted item whose task is gone. */
  onOpen: (() => void) | undefined;
  onEdit: () => void;
  onRun: () => void;
  /** The item is being started; its start button waits. */
  running: boolean;
  onTogglePause: () => void;
  onDelete: () => void;
  /** Archives the item's done task. */
  onArchive?: () => void;
}) {
  const OriginIcon = ORIGIN_ICONS[item.origin.kind];
  const promoted = item.status === "promoted";
  const archivable =
    state.kind === "promoted" && state.task?.status === "done" && state.task.archivedAt === null;
  const dropTarget = dragging !== null && dragging.id !== item.id;
  return (
    <li
      data-item-id={item.id}
      tabIndex={0}
      draggable
      aria-label={item.title}
      aria-keyshortcuts={`Alt+ArrowUp Alt+ArrowDown${onOpen ? " Enter" : ""} P Delete`}
      onClick={(event) => {
        if (!onOpen) return;
        // Leave clicks on the row's own buttons and links to them.
        const control = (event.target as Element).closest("button, a, input");
        if (control && event.currentTarget.contains(control)) return;
        if (window.getSelection()?.isCollapsed === false) return;
        onOpen();
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (dropTarget) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
        const key = event.key;
        if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
          event.preventDefault();
          onMove(key === "ArrowUp" ? -1 : 1);
        } else if (event.altKey) {
          return;
        } else if (key === "ArrowUp" || key === "k" || key === "K") {
          event.preventDefault();
          onFocusStep(-1);
        } else if (key === "ArrowDown" || key === "j" || key === "J") {
          event.preventDefault();
          onFocusStep(1);
        } else if (key === "Enter" && onOpen) {
          event.preventDefault();
          onOpen();
        } else if ((key === "p" || key === "P") && !promoted) {
          event.preventDefault();
          onTogglePause();
        } else if (key === "Delete") {
          event.preventDefault();
          onDelete();
        }
      }}
      className={cn(
        "group bw-chamfer bw-chamfer-focus flex min-h-10 items-center gap-2.5 py-1.5 pr-2 pl-1.5 [--bw-chamfer-line:transparent] hover:bg-card focus-visible:outline-none",
        onOpen && "cursor-pointer",
        dragging?.id === item.id && "opacity-50",
        dropTarget && "[--bw-chamfer-line:var(--border-strong)]",
      )}
    >
      <GripIcon className="cursor-grab text-faint" />
      <OriginIcon size="sm" className="text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate font-medium text-foreground-strong",
            promoted && "font-normal text-foreground",
          )}
        >
          {item.title}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-label text-faint">
          <span className="mono truncate">{originKey(item)}</span>
          <StackLabel origin={item.origin} />
          {dependsOn.length > 0 && <span className="truncate">after {dependsOn.join(", ")}</span>}
          {item.sourceTaskId && (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: item.sourceTaskId }}
              className="min-w-0 truncate text-muted-foreground"
              title={
                sourceTask ? `Proposed by: ${sourceTask}` : "The task that proposed this follow-up"
              }
            >
              {sourceTask ? `From ${sourceTask}` : "From task"}
            </Link>
          )}
        </span>
      </span>
      <StateChip state={state} />
      <span className="flex items-center gap-0.5">
        {!promoted && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={running}
              onClick={onRun}
              title="Start a task for this item now"
            >
              <PlayIcon size="sm" />
              Start working
            </Button>
            <Button size="sm" variant="ghost" onClick={onTogglePause} aria-keyshortcuts="P">
              {item.status === "paused" ? "Unpause" : "Pause"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          </>
        )}
        {archivable && onArchive && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onArchive}
            aria-label={`Archive ${item.title}`}
          >
            Archive
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="hover:text-destructive"
          onClick={onDelete}
          aria-label={`Delete ${item.title}`}
        >
          Delete
        </Button>
      </span>
    </li>
  );
}

/** A stacked PR's place in its stack (`stack #41 · 2/3`); nothing for other origins. */
function StackLabel({ origin }: { origin: TaskOrigin }) {
  const label = stackLabel(origin);
  return label ? (
    <span className="whitespace-nowrap" title={label.title}>
      {label.text}
    </span>
  ) : null;
}

/** A task in the backlog view; the row opens it, except for its trailing `action`. */
function TaskRow({
  task,
  fromBacklog,
  action,
}: {
  task: Task;
  fromBacklog: boolean;
  action?: ReactNode;
}) {
  const OriginIcon = ORIGIN_ICONS[task.origin.kind];
  return (
    <li className="bw-chamfer flex items-center gap-1 [--bw-chamfer-line:transparent] hover:bg-card">
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        className="bw-chamfer bw-chamfer-focus flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2 pl-1.5 text-foreground no-underline [--bw-chamfer-line:transparent] hover:no-underline focus-visible:outline-none"
      >
        <OriginIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground-strong">{task.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">{originKey(task)}</span>
            <StackLabel origin={task.origin} />
            {fromBacklog && <span className="whitespace-nowrap">from backlog</span>}
          </span>
        </span>
        <StatusBadge status={task.status} label={statusLabel(task)} />
      </Link>
      {action && <span className="flex flex-none items-center pr-2">{action}</span>}
    </li>
  );
}

/**
 * Assigns the issue to the user on GitHub and creates its task at once, even
 * with the runner off. The row then links to the task, and the user stays in the backlog.
 */
function WorkOnIssue({ issue, repoId }: { issue: RepoIssue; repoId: string }) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function work() {
    if (pending) return;
    setPending(true);
    setError(null);
    const origin = issueOrigin(issue);
    try {
      const task = await withCredential(
        { label: "Start working", target: originKey({ origin }) },
        () => createTask({ origin, repoId, assignToMe: true }),
      );
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
        tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repoIssues(repoId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.assignedIssues }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => void work()}
        title="Assign the issue to you and start a task"
      >
        Start working
      </Button>
      {error && <ErrorText className="max-w-60 text-right">{error}</ErrorText>}
    </span>
  );
}

/** A GitHub issue row's trailing action: a link to the work on it, else "Start working". */
function RepoIssueAction({
  issue,
  repoId,
  work,
}: {
  issue: RepoIssue;
  repoId: string;
  work: IssueWork;
}) {
  return work ? <IssueWorkLink work={work} /> : <WorkOnIssue issue={issue} repoId={repoId} />;
}

/**
 * Creates the Jira issue's task at once, even with the runner off; the issue
 * is neither assigned nor transitioned. The row then links to the task, and
 * the user stays in the backlog.
 */
function WorkOnJiraIssue({ issue, repoId }: { issue: RepoJiraIssue; repoId: string }) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function work() {
    if (pending) return;
    setPending(true);
    setError(null);
    const origin = jiraIssueOrigin(issue);
    try {
      const task = await withCredential(
        { label: "Start working", target: originKey({ origin }) },
        () => createTask({ origin, repoId }),
      );
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
        tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
      );
      await queryClient.invalidateQueries({ queryKey: ["repo-jira-issues", repoId] });
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => void work()}
        title="Start a task"
      >
        Start working
      </Button>
      {error && <ErrorText className="max-w-60 text-right">{error}</ErrorText>}
    </span>
  );
}

/** Title-only Blackwall items, added with Enter. */
function QuickAdd({ repoId, onError }: { repoId: string; onError: (error: string) => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const title = text.trim();
    if (!title || pending) return;
    setPending(true);
    try {
      await createBacklogItem(repoId, { origin: { kind: "free-text" }, title, freeText: title });
      setText("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="relative">
      <span className="pointer-events-none absolute top-2 left-[9px] flex text-faint">
        <PlusIcon />
      </span>
      <Input
        aria-label="Quick add a Blackwall item"
        placeholder="Quick add: describe the work, Enter adds it to the queue"
        className="pr-10 pl-[30px]"
        maxLength={120}
        value={text}
        disabled={pending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setText("");
            event.currentTarget.blur();
          }
        }}
      />
      <Kbd className="absolute top-1.5 right-2" aria-hidden="true">
        ↵
      </Kbd>
    </form>
  );
}

type Dialog =
  | { kind: "edit"; item: BacklogItemView }
  | { kind: "delete"; item: BacklogItemView }
  | { kind: "push"; sync: RepoSync }
  | null;

/** A repo's backlog: what waits, in pick order, and why the runner is or isn't promoting it. */
export function Backlog({
  repoId,
  openItemId,
}: {
  repoId: string;
  openItemId?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const backlog = useQuery(backlogQuery(repoId));
  const runner = useQuery(backlogRunnerQuery(repoId));
  const settings = useQuery(settingsQuery);
  const tasks = useQuery(tasksQuery);
  const quota = useQuery(quotaQuery);
  const roleDefaults = useQuery(roleDefaultsQuery);
  const sync = useQuery(repoSyncQuery(repoId));
  const repoIssues = useQuery(repoIssuesQuery(repoId, issuesRefreshSeconds(settings.data)));
  const jiraProject = repos.data?.find((r) => r.id === repoId)?.jiraProject ?? null;
  const repoJiraIssues = useQuery(
    repoJiraIssuesQuery(repoId, jiraProject, issuesRefreshSeconds(settings.data)),
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BacklogItemView | null>(null);
  // Items being started, so a second click does not hit "already promoted".
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());

  useEscapeTo(() => void navigate({ to: "/" }));
  const [showArchive, setShowArchive] = useState(false);
  const [archiveFilter, setArchiveFilter] = useState("");
  const focusAfter = useRef<string | null>(null);
  const [pushed, setPushed] = useState<{ repoId: string; branch: string; at: number } | null>(null);
  // The push button unmounts on success, so focus moves to the note instead.
  const noteRef = useRef<HTMLSpanElement>(null);
  const pushSucceeded = useRef(false);

  // Tick every second while a quota pause may be counting down.
  const now = useNow(quota.data?.some((q) => q.pausedUntil !== null) ? 1000 : 30_000);

  const repo = repos.data?.find((r) => r.id === repoId);
  const items = useMemo(() => backlog.data ?? [], [backlog.data]);
  const repoTasks = useMemo(
    () => (tasks.data ?? []).filter((t) => t.repoId === repoId),
    [tasks.data, repoId],
  );
  const taskById = useMemo(
    () => new Map<string, Task>(repoTasks.map((t) => [t.id, t])),
    [repoTasks],
  );
  const sections = useMemo(
    () => backlogSections(items, tasks.isError ? [] : repoTasks),
    [items, repoTasks, tasks.isError],
  );
  const shown = useMemo(() => new Set(sections.items.map((i) => i.id)), [sections]);
  // Filtered in the view only: the archive bar keeps counting every archived task.
  const archivedShown = useMemo(
    () => sections.archived.filter((t) => matchesFilter(t, archiveFilter)),
    [sections.archived, archiveFilter],
  );
  const linked = useMemo(
    () => new Set(items.flatMap((i) => (i.taskId ? [i.taskId] : []))),
    [items],
  );
  const issues = repoIssues.data?.issues ?? [];
  const jiraIssues = (jiraProject && repoJiraIssues.data?.issues) || [];
  const titles = useMemo(() => new Map(items.map((i) => [i.id, i.title])), [items]);
  // Across all repos: a follow-up can land in a different repo from its source task.
  const taskTitles = useMemo(
    () => new Map((tasks.data ?? []).map((t) => [t.id, t.title])),
    [tasks.data],
  );
  const clisFor = (item: BacklogItemView) =>
    backlogAgentClis(
      resolvedRoles(item.agents, roleDefaults.data ?? {}),
      item.agentClis,
      repo?.defaultCli ?? "claude",
    );

  const status =
    settings.data && runner.data && backlog.data && tasks.data
      ? runnerStatus({
          settings: settings.data,
          repo,
          runner: runner.data,
          items,
          tasks: repoTasks,
          quota: quota.data ?? [],
          clisFor,
          now,
        })
      : null;
  const nextId = nextBacklogItem(items)?.id;
  // A sync error (stale repo included) just hides the control.
  const control = syncControl(sync.data);
  const note = pushed?.repoId === repoId ? pushed : null;

  // "Pushed to main" shows for a few seconds, then any current control returns.
  useEffect(() => {
    if (!pushed) return;
    const timer = setTimeout(() => setPushed(null), PUSHED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [pushed]);

  // Opening a backlog selects its repo, however it was reached; never a repo that isn't there.
  const missing = repos.data !== undefined && !repo;
  useEffect(() => {
    if (!missing) setSelectedRepo(repoId);
  }, [repoId, missing]);

  // An item picked in the search palette opens in the editor once loaded; the URL then forgets it,
  // so Back or a reload does not open it again. A promoted or deleted item just shows the list.
  const [openedItemId, setOpenedItemId] = useState<string | undefined>(undefined);
  if (openItemId !== openedItemId && (!openItemId || backlog.data)) {
    setOpenedItemId(openItemId);
    const item = openItemId ? backlog.data?.find((i) => i.id === openItemId) : undefined;
    if (item && item.status !== "promoted") setDialog({ kind: "edit", item });
  }
  useEffect(() => {
    if (!openedItemId) return;
    document
      .querySelector(`[data-item-id="${CSS.escape(openedItemId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    void navigate({ to: "/repos/$repoId/backlog", params: { repoId }, search: {}, replace: true });
  }, [openedItemId, navigate, repoId]);

  // Keep focus on a row the keyboard just moved.
  useEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`)?.focus();
  }, [items]);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
    }
  }

  // Starts the item's task and stays in the backlog; the row then links to the task.
  async function run(item: BacklogItemView) {
    if (running.has(item.id)) return;
    setRunning((ids) => new Set(ids).add(item.id));
    await act(async () => {
      const task = await runBacklogItem(repoId, item.id);
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
        tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
      );
    });
    setRunning((ids) => {
      const next = new Set(ids);
      next.delete(item.id);
      return next;
    });
  }

  async function setArchived(task: Task, archived: boolean) {
    setError(null);
    try {
      await (archived ? archiveTask(task.id) : unarchiveTask(task.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      // The task.upserted event may arrive after the response.
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
    }
  }

  function reorder(ids: string[] | null, focusId?: string) {
    if (!ids) return;
    const byId = new Map(items.map((i) => [i.id, i]));
    queryClient.setQueryData<BacklogItemView[]>(
      queryKeys.backlog(repoId),
      ids.map((id) => byId.get(id)!),
    );
    if (focusId) focusAfter.current = focusId;
    void act(() => reorderBacklog(repoId, ids));
  }

  function focusStep(id: string, delta: -1 | 1) {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-item-id]")];
    const index = rows.findIndex((row) => row.dataset.itemId === id);
    rows[index + delta]?.focus();
  }

  if (repos.data && !repo) {
    return (
      <EmptyState key="not-found" title="Repo not found">
        It may have been removed in Settings.
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={cn(paneHeader, "flex-wrap gap-y-1.5")}>
        <BacklogIcon className="text-muted-foreground" />
        <h1 className={paneTitle}>Backlog</h1>
        <span className="mono min-w-0 truncate text-meta text-muted-foreground" title={repo?.name}>
          {repo?.name ?? ""}
        </span>
        {backlog.data && (
          <span className="mono text-label text-faint">{pendingCount(items)} waiting</span>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {/* Always mounted so screen readers announce the note when its text appears. */}
          <span
            ref={noteRef}
            role="status"
            aria-live="polite"
            tabIndex={-1}
            className="mono text-label text-done focus:outline-none"
          >
            {note && (
              <span key={note.at} className="animate-pushed-glow">
                Pushed to {note.branch}
              </span>
            )}
          </span>
          {!note && control?.kind === "push" && sync.data && (
            <Button
              size="sm"
              className="shrink-0"
              title={control.title}
              onClick={() => setDialog({ kind: "push", sync: sync.data! })}
            >
              {control.label}
            </Button>
          )}
          {!note && control?.kind === "diverged" && (
            <span className="mono text-label text-faint">{control.text}</span>
          )}
        </div>
      </div>

      <RunnerBar
        repoId={repoId}
        status={status}
        enabled={runner.data?.enabled}
        autonomous={runner.data?.autonomous}
        defaultBranch={repo?.defaultBranch ?? "main"}
        globalOn={settings.data?.backlogRunner ?? true}
        includeRemoteIssues={runner.data?.includeRemoteIssues}
        hasRemoteIssues={issues.length > 0}
      />

      <div className={paneBody}>
        <QuickAdd repoId={repoId} onError={setError} />
        {error && <ErrorText>{error}</ErrorText>}

        {backlog.isPending || tasks.isPending ? (
          <EmptyState key="loading" role="status" title="Reading the backlog…" />
        ) : backlog.isError ? (
          <EmptyState
            key="error"
            role="alert"
            title="Could not load the backlog"
            onRetry={() => void backlog.refetch()}
          >
            {backlog.error.message}
          </EmptyState>
        ) : (
          <>
            {tasks.isError && (
              <EmptyState
                role="alert"
                title="Could not load tasks"
                onRetry={() => void tasks.refetch()}
              >
                {tasks.error.message}
              </EmptyState>
            )}
            {items.length === 0 &&
              sections.active.length === 0 &&
              sections.earlier.length === 0 &&
              issues.length === 0 &&
              jiraIssues.length === 0 &&
              !(showArchive && sections.archived.length > 0) && (
                <EmptyState title="Queue empty. Nothing waiting.">
                  Park work here and the runner starts it when the repo is idle. Quick add a line
                  above, or use New task for a Jira issue or PR.
                </EmptyState>
              )}
            {sections.active.length > 0 && (
              <Section label="In progress" ariaLabel="In progress" count={sections.active.length}>
                {sections.active.map((task) => (
                  <TaskRow key={task.id} task={task} fromBacklog={linked.has(task.id)} />
                ))}
              </Section>
            )}
            {sections.items.length > 0 && (
              <Section label="Queue" ariaLabel="Queue" count={sections.items.length}>
                {sections.items.map((item) => {
                  const state = itemState(item, { nextId, titles, tasks: taskById });
                  const action = rowAction(state);
                  return (
                    <BacklogRow
                      key={item.id}
                      item={item}
                      state={state}
                      dependsOn={item.dependsOn.map((id) => titles.get(id) ?? "a deleted item")}
                      sourceTask={item.sourceTaskId ? taskTitles.get(item.sourceTaskId) : undefined}
                      dragging={dragging}
                      onDragStart={() => setDragging(item)}
                      onDragEnd={() => setDragging(null)}
                      onDrop={() => {
                        if (dragging) reorder(reorderIds(items, dragging.id, item.id));
                        setDragging(null);
                      }}
                      onMove={(delta) => reorder(moveItem(items, item.id, delta, shown), item.id)}
                      onFocusStep={(delta) => focusStep(item.id, delta)}
                      onOpen={
                        action?.kind === "edit"
                          ? () => setDialog({ kind: "edit", item })
                          : action?.kind === "open-task"
                            ? () =>
                                void navigate({
                                  to: "/tasks/$taskId",
                                  params: { taskId: action.taskId },
                                })
                            : undefined
                      }
                      onEdit={() => setDialog({ kind: "edit", item })}
                      onRun={() => void run(item)}
                      running={running.has(item.id)}
                      onTogglePause={() =>
                        void act(() =>
                          updateBacklogItem(repoId, item.id, {
                            status: item.status === "paused" ? "waiting" : "paused",
                          }),
                        )
                      }
                      onDelete={() => setDialog({ kind: "delete", item })}
                      onArchive={() => {
                        const task = item.taskId ? taskById.get(item.taskId) : undefined;
                        if (task) void setArchived(task, true);
                      }}
                    />
                  );
                })}
              </Section>
            )}
            {repoIssues.data?.errors.map((issuesError) => (
              <EmptyState
                key={`issues-error:${issuesError.host}`}
                role="alert"
                title={`Could not load GitHub issues from ${issuesError.host}`}
                className="flex-none"
                onRetry={() => void repoIssues.refetch()}
              >
                {issuesError.message}
              </EmptyState>
            ))}
            {issues.length > 0 && (
              <Section label="GitHub issues" ariaLabel="GitHub issues" count={issues.length}>
                {issues.map((issue) => (
                  <IssueRow
                    key={issue.url}
                    issue={issue}
                    now={now}
                    assignees={issue.assignees}
                    action={
                      <RepoIssueAction
                        issue={issue}
                        repoId={repoId}
                        work={issueWork(issue, tasks.data ?? [], items)}
                      />
                    }
                  />
                ))}
              </Section>
            )}
            {jiraProject &&
              repoJiraIssues.data?.errors.map((issuesError) => (
                <EmptyState
                  key={`jira-issues-error:${issuesError.host}`}
                  role="alert"
                  title={`Could not load Jira issues from ${issuesError.host}`}
                  className="flex-none"
                  onRetry={() => void repoJiraIssues.refetch()}
                >
                  {issuesError.message}
                </EmptyState>
              ))}
            {jiraIssues.length > 0 && (
              <Section label="Jira issues" ariaLabel="Jira issues" count={jiraIssues.length}>
                {jiraIssues.map((issue) => {
                  const work = jiraIssueWork(issue, tasks.data ?? [], items);
                  return (
                    <JiraIssueRow
                      key={issue.url}
                      issue={issue}
                      now={now}
                      action={
                        work ? (
                          <IssueWorkLink work={work} />
                        ) : (
                          <WorkOnJiraIssue issue={issue} repoId={repoId} />
                        )
                      }
                    />
                  );
                })}
              </Section>
            )}
            {sections.earlier.length > 0 && (
              <Section label="Other tasks" ariaLabel="Other tasks" count={sections.earlier.length}>
                {sections.earlier.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    fromBacklog={false}
                    action={
                      task.status === "done" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void setArchived(task, true)}
                          aria-label={`Archive ${task.title}`}
                        >
                          Archive
                        </Button>
                      )
                    }
                  />
                ))}
              </Section>
            )}
            {showArchive &&
              (sections.archived.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <label className="relative block">
                    <span className="pointer-events-none absolute top-[7px] left-[9px] flex text-faint">
                      <SearchIcon />
                    </span>
                    <Input
                      type="search"
                      placeholder="Search archive"
                      aria-label="Search archived tasks"
                      className="h-7 pl-[30px]"
                      value={archiveFilter}
                      onChange={(event) => setArchiveFilter(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setArchiveFilter("");
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  {archivedShown.length > 0 ? (
                    <Section label="Archived" ariaLabel="Archived" count={archivedShown.length}>
                      {archivedShown.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          fromBacklog={linked.has(task.id)}
                          action={
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void setArchived(task, false)}
                              aria-label={`Unarchive ${task.title}`}
                            >
                              Unarchive
                            </Button>
                          }
                        />
                      ))}
                    </Section>
                  ) : (
                    <p className="m-0 px-1.5 text-label text-faint">
                      No archived tasks match “{archiveFilter.trim()}”
                    </p>
                  )}
                </div>
              ) : (
                <p className="m-0 px-1.5 text-label text-faint">No archived tasks</p>
              ))}
          </>
        )}
      </div>

      {tasks.data && (
        <ArchiveBar
          archived={sections.archived.length}
          archivable={sections.archivable}
          shown={showArchive}
          onToggle={() => {
            if (showArchive) setArchiveFilter("");
            setShowArchive(!showArchive);
          }}
        />
      )}

      <NewTaskModal
        open={dialog?.kind === "edit"}
        item={dialog?.kind === "edit" ? dialog.item : undefined}
        onClose={() => setDialog(null)}
      />
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete backlog item"
          confirmLabel="Delete item"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await deleteBacklogItem(repoId, dialog.item.id);
            await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
          }}
        >
          Remove “{dialog.item.title}” from the backlog.
          {dialog.item.status === "promoted"
            ? " Its task stays."
            : " Items that depend on it stay blocked until you edit them."}
        </ConfirmDialog>
      )}
      {dialog?.kind === "push" && (
        <ConfirmDialog
          title={`Push to ${dialog.sync.branch}`}
          confirmLabel={`Push to ${dialog.sync.branch}`}
          confirmVariant="default"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await pushRepo(repoId);
            pushSucceeded.current = true;
            setPushed({ repoId, branch: dialog.sync.branch, at: Date.now() });
            await queryClient.invalidateQueries({ queryKey: queryKeys.repoSync(repoId) });
          }}
          onCloseAutoFocus={(event) => {
            if (!pushSucceeded.current) return;
            event.preventDefault();
            pushSucceeded.current = false;
            noteRef.current?.focus();
          }}
        >
          Push {plural(dialog.sync.ahead, "commit")} from local {dialog.sync.branch} in {repo?.name}{" "}
          to origin/{dialog.sync.branch}. This publishes them to the remote.
        </ConfirmDialog>
      )}
    </div>
  );
}
