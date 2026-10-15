import type { Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { useNow } from "../hooks";
import { activeAgentsLabel, doneTasks, groupTasks, matchesFilter } from "../inbox";
import { isPlainKey, isTypingTarget, useWindowKeydown } from "../keyboard";
import { cn } from "../lib/utils";
import { useLiveStatus } from "../live-status";
import { activeAgentsQuery, reposQuery, tasksQuery } from "../query";
import { agentClis } from "../task-view";
import { EmptyState } from "./EmptyState";
import { PlusIcon, SearchIcon } from "./icons";
import { NewTaskModal } from "./NewTaskModal";
import { TaskCard } from "./TaskCard";
import { useArchive } from "./use-archive-launches";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";

const GROUPS = [
  { key: "needsYou", label: "Needs you", tone: "text-magenta" },
  { key: "running", label: "Running", tone: "text-cyan" },
  { key: "recent", label: "Recent", tone: "text-muted-foreground" },
] as const;

function TaskList({ tasks, filter }: { tasks: Task[]; filter: string }) {
  const repos = useQuery(reposQuery);
  const now = useNow();
  const repoNames = useMemo(
    () => new Map((repos.data ?? []).map((repo) => [repo.id, repo.name])),
    [repos.data],
  );
  const groups = groupTasks(tasks.filter((task) => matchesFilter(task, filter)));

  if (tasks.every((task) => task.archivedAt !== null)) {
    return (
      <EmptyState key="empty" title="The wall is quiet">
        Tasks you start show up here; archived tasks stay in each repo&apos;s backlog.
      </EmptyState>
    );
  }
  if (GROUPS.every((g) => groups[g.key].length === 0)) {
    return (
      <EmptyState key="no-match" title="No tasks match">
        Nothing matches “{filter.trim()}”.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
      {GROUPS.map(({ key, label, tone }) => {
        const list = groups[key];
        if (list.length === 0) return null;
        return (
          <section key={key} aria-label={label} className="flex flex-col gap-0.5">
            <h2 className="flex items-center gap-2 px-1.5 pt-2 pb-1 pl-2">
              <span className={cn("label", tone)}>{label}</span>
              <span className="mono text-label text-faint">{list.length}</span>
              <span className="h-px flex-1 bg-border" />
            </h2>
            {list.map((task) => {
              const repoName = repoNames.get(task.repoId);
              return (
                <TaskCard
                  key={task.id}
                  task={task}
                  now={now}
                  clis={agentClis(task)}
                  {...(repoName ? { repoName } : {})}
                />
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

const LIVE_LABELS = { open: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" };

/** The socket state and, while live, how many agents run; opens the active agents page. */
function LiveIndicator() {
  const status = useLiveStatus();
  const active = useQuery(activeAgentsQuery);
  const agents = status === "open" ? activeAgentsLabel(active.data?.length ?? 0) : null;
  return (
    <Link
      to="/active"
      className="inline-flex items-center gap-1.5 text-muted-foreground no-underline hover:text-foreground hover:no-underline"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          status === "open" ? "bg-done" : "animate-blink-needs bg-interrupted",
        )}
      />
      <span role="status">
        {LIVE_LABELS[status]}
        {agents && <span className="text-cyan"> · {agents}</span>}
      </span>
    </Link>
  );
}

/** Left pane: the task inbox, grouped needs you → running → recent. */
export function Inbox() {
  const tasks = useQuery(tasksQuery);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const launch = useArchive();
  const done = doneTasks(tasks.data ?? []).filter((t) => !launch.launches.has(t.id));

  useWindowKeydown((event) => {
    if (!isPlainKey(event) || isTypingTarget(event.target)) return;
    if (event.key === "/") {
      event.preventDefault();
      filterInput.current?.focus();
    } else if (event.key.toLowerCase() === "n" && !document.querySelector("[role=dialog]")) {
      event.preventDefault();
      setCreating(true);
    }
  });

  return (
    <aside
      aria-label="Task inbox"
      className="flex h-full w-[352px] min-w-0 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <div className="border-b border-border py-3 pr-3 pl-3.5">
        <div className="flex items-center gap-2">
          <label className="relative block min-w-0 flex-1">
            <span className="pointer-events-none absolute top-[7px] left-[9px] flex text-faint">
              <SearchIcon />
            </span>
            <Input
              ref={filterInput}
              type="search"
              placeholder="Filter tasks"
              aria-label="Filter tasks"
              className="h-7 pr-[30px] pl-[30px]"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFilter("");
                  event.currentTarget.blur();
                }
              }}
            />
            <Kbd className="absolute top-[5px] right-1.5">/</Kbd>
          </label>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            New task
            <Kbd onFill aria-hidden="true">
              N
            </Kbd>
          </Button>
        </div>
      </div>

      {tasks.isPending ? (
        <EmptyState key="loading" role="status" title="Pulling the task list…" />
      ) : tasks.isError ? (
        <EmptyState
          key="error"
          role="alert"
          title="Could not load tasks"
          onRetry={() => void tasks.refetch()}
        >
          {tasks.error.message}
        </EmptyState>
      ) : (
        <TaskList tasks={tasks.data} filter={filter} />
      )}

      <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2 text-label text-muted-foreground">
        <LiveIndicator />
        <span className="flex-1" />
        {done.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            title="Archive all done tasks"
            onClick={() => {
              launch.clearError();
              launch.archiveAll(done);
            }}
          >
            Archive {done.length} done
          </Button>
        )}
      </div>
      <NewTaskModal open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}
