import { AGENT_ROLES, type BacklogItemView, type RoleAgents, type Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  archiveTask,
  createBacklogItem,
  deleteBacklogItem,
  reorderBacklog,
  resumeBacklogRunner,
  runBacklogItem,
  setBacklogRunner,
  unarchiveTask,
  updateBacklogItem,
} from "../api";
import {
  PRIORITY_LABELS,
  backlogSections,
  itemState,
  moveInBucket,
  nextBacklogItem,
  pendingCount,
  reorderIds,
  rowAction,
  runnerStatus,
  type BacklogItemState,
  type RunnerStatus,
} from "../backlog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  BacklogIcon,
  FailedIcon,
  GripIcon,
  JiraIcon,
  PausedIcon,
  PlayIcon,
  PlusIcon,
  PullRequestIcon,
  TextIcon,
  WallIcon,
} from "../components/icons";
import { NewTaskModal } from "../components/NewTaskModal";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { originKey } from "../inbox";
import { cn } from "../lib/utils";
import {
  agentsQuery,
  backlogQuery,
  backlogRunnerQuery,
  queryKeys,
  quotaQuery,
  reposQuery,
  roleDefaultsQuery,
  settingsQuery,
  tasksQuery,
} from "../query";
import { setSelectedRepo } from "../selected-repo";
import { errorMessage } from "../settings-forms";
import { agentClis } from "../task-view";

const ORIGIN_ICONS = {
  "jira-issue": JiraIcon,
  "github-pr": PullRequestIcon,
  "free-text": TextIcon,
} as const;

/** Re-renders every `ms` so countdowns stay current. */
function useNow(ms: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/** An item's role agents with the role defaults filled in, as the server resolves them. */
function resolvedRoles(agents: RoleAgents, defaults: RoleAgents): RoleAgents {
  const roles: RoleAgents = { ...defaults };
  for (const role of AGENT_ROLES) {
    if (agents[role] !== undefined) Object.assign(roles, { [role]: agents[role] });
  }
  return roles;
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <WallIcon className="size-7 text-faint" />
      <div className="font-medium text-foreground-strong">{title}</div>
      {children && <div className="max-w-80 text-meta text-muted-foreground">{children}</div>}
    </div>
  );
}

const RUNNER_TONES: Record<RunnerStatus["tone"], { text: string; dot: string }> = {
  off: { text: "text-faint", dot: "bg-faint" },
  idle: { text: "text-muted-foreground", dot: "bg-muted-foreground" },
  ready: { text: "text-running", dot: "bg-running" },
  waiting: { text: "text-interrupted", dot: "bg-interrupted" },
  paused: { text: "text-interrupted", dot: "bg-interrupted" },
  halted: { text: "text-failed", dot: "bg-failed" },
};

/** Says why the runner is or isn't promoting something; switches it per repo and resumes a halt. */
function RunnerBar({
  repoId,
  status,
  enabled,
  globalOn,
}: {
  repoId: string;
  status: RunnerStatus | null;
  enabled: boolean | undefined;
  globalOn: boolean;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-sidebar px-5 py-2"
      aria-label="Backlog runner"
      role="region"
    >
      <span className="label text-muted-foreground">Runner</span>
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
          <span className="truncate text-muted-foreground">{status.detail}</span>
          {status.haltedTaskId && (
            <Link
              to="/tasks/$taskId"
              params={{ taskId: status.haltedTaskId }}
              className="text-meta whitespace-nowrap"
            >
              Open task
            </Link>
          )}
        </span>
      ) : (
        <span className="flex-1 text-muted-foreground">Loading…</span>
      )}
      {error && (
        <span className="text-meta text-destructive" role="alert">
          {error}
        </span>
      )}
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
            "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-meta text-muted-foreground has-focus-visible:shadow-ring",
            !globalOn && "opacity-60",
          )}
          title={globalOn ? undefined : "The runner is off for every repo in Settings"}
        >
          <input
            type="checkbox"
            className="accent-primary focus:outline-none"
            checked={enabled}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.checked;
              void act(() => setBacklogRunner(repoId, next));
            }}
          />
          Run this repo&apos;s backlog
        </label>
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
      className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border bg-sidebar px-5 py-2"
      aria-label="Archive"
      role="region"
    >
      <span className="label text-muted-foreground">Archive</span>
      <span className="mono flex-1 text-label text-faint">{archived} archived</span>
      {error && (
        <span className="text-meta text-destructive" role="alert">
          {error}
        </span>
      )}
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
        <span className="inline-flex h-5 items-center gap-[5px] rounded-full bg-running/12 px-[7px] text-label font-semibold whitespace-nowrap text-running">
          <span className="size-1.5 rounded-full bg-running" aria-hidden="true" />
          Next up
        </span>
      );
    case "waiting":
      return <span className="text-label whitespace-nowrap text-muted-foreground">Waiting</span>;
    case "paused":
      return (
        <span className="inline-flex h-5 items-center gap-1 rounded-full bg-interrupted/12 px-[7px] text-label font-semibold whitespace-nowrap text-interrupted">
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
          <StatusBadge status={state.task.status} />
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
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onFocusStep,
  onOpen,
  onEdit,
  onRun,
  onTogglePause,
  onDelete,
  onArchive,
}: {
  item: BacklogItemView;
  state: BacklogItemState;
  /** Titles of the items it depends on. */
  dependsOn: string[];
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
  onTogglePause: () => void;
  onDelete: () => void;
  /** Archives the item's done task. */
  onArchive?: () => void;
}) {
  const OriginIcon = ORIGIN_ICONS[item.origin.kind];
  const promoted = item.status === "promoted";
  const archivable =
    state.kind === "promoted" && state.task?.status === "done" && state.task.archivedAt === null;
  const dropTarget =
    dragging !== null && dragging.id !== item.id && dragging.priority === item.priority;
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
        "group flex min-h-10 items-center gap-2.5 rounded-lg border border-transparent py-1.5 pr-2 pl-1.5 hover:bg-card focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none",
        onOpen && "cursor-pointer",
        dragging?.id === item.id && "opacity-50",
        dropTarget && "border-dashed border-border-strong",
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
          {dependsOn.length > 0 && <span className="truncate">after {dependsOn.join(", ")}</span>}
        </span>
      </span>
      <StateChip state={state} />
      <span className="flex items-center gap-0.5">
        {!promoted && (
          <>
            <Button size="sm" variant="ghost" onClick={onRun} title="Promote to a task now">
              <PlayIcon size="sm" />
              Run now
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
    <li className="flex items-center gap-1 rounded-lg hover:bg-card">
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-transparent py-1.5 pr-2 pl-1.5 text-foreground no-underline hover:no-underline focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none"
      >
        <OriginIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground-strong">{task.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">{originKey(task)}</span>
            {fromBacklog && <span className="whitespace-nowrap">from backlog</span>}
          </span>
        </span>
        <StatusBadge status={task.status} />
      </Link>
      {action && <span className="flex flex-none items-center pr-2">{action}</span>}
    </li>
  );
}

/** A labelled group of rows: label, count and a rule. */
function Section({
  label,
  ariaLabel,
  count,
  children,
}: {
  label: string;
  ariaLabel: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel}>
      <h2 className="m-0 flex items-center gap-2 px-1.5 pt-1 pb-1">
        <span className="label text-muted-foreground">{label}</span>
        <span className="mono text-label text-faint">{count}</span>
        <span className="h-px flex-1 bg-border" />
      </h2>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>
    </section>
  );
}

/** Title-only free text items, added with Enter. */
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
        aria-label="Quick add a free text item"
        placeholder="Quick add: describe the work, Enter adds it at normal priority"
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
  { kind: "edit"; item: BacklogItemView } | { kind: "delete"; item: BacklogItemView } | null;

/** A repo's backlog: what waits, in pick order, and why the runner is or isn't promoting it. */
export function Backlog({ repoId }: { repoId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const repos = useQuery(reposQuery);
  const backlog = useQuery(backlogQuery(repoId));
  const runner = useQuery(backlogRunnerQuery(repoId));
  const settings = useQuery(settingsQuery);
  const tasks = useQuery(tasksQuery);
  const quota = useQuery(quotaQuery);
  const agents = useQuery(agentsQuery);
  const roleDefaults = useQuery(roleDefaultsQuery);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<BacklogItemView | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const focusAfter = useRef<string | null>(null);

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
  const shown = useMemo(
    () => new Set(sections.groups.flatMap((g) => g.items.map((i) => i.id))),
    [sections],
  );
  const linked = useMemo(
    () => new Set(items.flatMap((i) => (i.taskId ? [i.taskId] : []))),
    [items],
  );
  const titles = useMemo(() => new Map(items.map((i) => [i.id, i.title])), [items]);
  const library = useMemo(() => new Map((agents.data ?? []).map((a) => [a.id, a])), [agents.data]);
  const clisFor = (item: BacklogItemView) =>
    agentClis(
      resolvedRoles(item.agents, roleDefaults.data?.[repo?.defaultCli ?? "claude"] ?? {}),
      library,
    );

  const status =
    settings.data && runner.data && backlog.data && tasks.data
      ? runnerStatus({
          settings: settings.data,
          runner: runner.data,
          items,
          tasks: repoTasks,
          quota: quota.data ?? [],
          clisFor,
          now,
        })
      : null;
  const nextId = nextBacklogItem(items)?.id;

  // Opening a backlog selects its repo, however it was reached; never a repo that isn't there.
  const missing = repos.data !== undefined && !repo;
  useEffect(() => {
    if (!missing) setSelectedRepo(repoId);
  }, [repoId, missing]);

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
    return <Message title="Repo not found">It may have been removed in Settings.</Message>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-[52px] items-center gap-2.5 border-b border-border px-5 py-3">
        <BacklogIcon className="text-muted-foreground" />
        <h1 className="m-0 text-heading font-semibold text-foreground-strong">Backlog</h1>
        <span className="mono text-meta text-muted-foreground">{repo?.name ?? ""}</span>
        {backlog.data && (
          <span className="mono text-label text-faint">{pendingCount(items)} waiting</span>
        )}
      </div>

      <RunnerBar
        repoId={repoId}
        status={status}
        enabled={runner.data?.enabled}
        globalOn={settings.data?.backlogRunner ?? true}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        <QuickAdd repoId={repoId} onError={setError} />
        {error && (
          <p className="m-0 text-meta text-destructive" role="alert">
            {error}
          </p>
        )}

        {backlog.isPending || tasks.isPending ? (
          <Message title="Loading backlog…" />
        ) : backlog.isError ? (
          <Message title="Could not load the backlog">
            {backlog.error.message}{" "}
            <Button variant="ghost" size="sm" onClick={() => void backlog.refetch()}>
              Retry
            </Button>
          </Message>
        ) : (
          <>
            {tasks.isError && (
              <Message title="Could not load tasks">
                {tasks.error.message}{" "}
                <Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>
                  Retry
                </Button>
              </Message>
            )}
            {items.length === 0 &&
              sections.active.length === 0 &&
              sections.earlier.length === 0 &&
              !(showArchive && sections.archived.length > 0) && (
                <Message title="Nothing waiting">
                  Park work here and the runner starts it when the repo is idle. Quick add a line
                  above, or use New task for a Jira issue or PR.
                </Message>
              )}
            {sections.active.length > 0 && (
              <Section label="In progress" ariaLabel="In progress" count={sections.active.length}>
                {sections.active.map((task) => (
                  <TaskRow key={task.id} task={task} fromBacklog={linked.has(task.id)} />
                ))}
              </Section>
            )}
            {sections.groups.map((group) => (
              <Section
                key={group.priority}
                label={PRIORITY_LABELS[group.priority]}
                ariaLabel={`${PRIORITY_LABELS[group.priority]} priority`}
                count={group.items.length}
              >
                {group.items.map((item) => {
                  const state = itemState(item, { nextId, titles, tasks: taskById });
                  const action = rowAction(state);
                  return (
                    <BacklogRow
                      key={item.id}
                      item={item}
                      state={state}
                      dependsOn={item.dependsOn.map((id) => titles.get(id) ?? "a deleted item")}
                      dragging={dragging}
                      onDragStart={() => setDragging(item)}
                      onDragEnd={() => setDragging(null)}
                      onDrop={() => {
                        if (dragging) reorder(reorderIds(items, dragging.id, item.id));
                        setDragging(null);
                      }}
                      onMove={(delta) =>
                        reorder(moveInBucket(items, item.id, delta, shown), item.id)
                      }
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
                      onRun={() =>
                        void act(async () => {
                          const task = await runBacklogItem(repoId, item.id);
                          void navigate({ to: "/tasks/$taskId", params: { taskId: task.id } });
                        })
                      }
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
            ))}
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
                <Section label="Archived" ariaLabel="Archived" count={sections.archived.length}>
                  {sections.archived.map((task) => (
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
                <p className="m-0 px-1.5 text-label text-faint">No archived tasks</p>
              ))}
            {sections.groups.length > 0 && (
              <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 text-label text-faint">
                <span>
                  <Kbd>J</Kbd> <Kbd>K</Kbd> move
                </span>
                <span>
                  <Kbd>Alt ↑</Kbd> <Kbd>Alt ↓</Kbd> reorder
                </span>
                <span>
                  <Kbd>↵</Kbd> open
                </span>
                <span>
                  <Kbd>P</Kbd> pause
                </span>
                <span>
                  <Kbd>Del</Kbd> delete
                </span>
              </p>
            )}
          </>
        )}
      </div>

      {tasks.data && (
        <ArchiveBar
          archived={sections.archived.length}
          archivable={sections.archivable}
          shown={showArchive}
          onToggle={() => setShowArchive((shown) => !shown)}
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
    </div>
  );
}
