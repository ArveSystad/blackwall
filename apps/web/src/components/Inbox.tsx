import type { Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { groupTasks, matchesFilter, needsYouCount } from "../inbox";
import { isPlainKey, isTypingTarget } from "../keyboard";
import { cn } from "../lib/utils";
import { useLiveStatus } from "../live-status";
import { agentsQuery, reposQuery, tasksQuery } from "../query";
import { agentClis } from "../task-view";
import { BacklogNav } from "./BacklogNav";
import { GearIcon, PlusIcon, SearchIcon, WallIcon } from "./icons";
import { NewTaskModal } from "./NewTaskModal";
import { QuotaChip } from "./QuotaChip";
import { StatusBadge } from "./StatusBadge";
import { TaskCard } from "./TaskCard";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Kbd } from "./ui/kbd";
import { Wordmark } from "./Wordmark";

const GROUPS = [
  { key: "needsYou", label: "Needs you", tone: "text-magenta" },
  { key: "running", label: "Running", tone: "text-cyan" },
  { key: "recent", label: "Recent", tone: "text-muted-foreground" },
] as const;

/** Re-renders every minute so relative times stay current. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <WallIcon className="size-7 text-faint" />
      <div className="font-medium text-foreground-strong">{title}</div>
      {children && <div className="max-w-60 text-meta text-muted-foreground">{children}</div>}
    </div>
  );
}

function TaskList({ tasks, filter }: { tasks: Task[]; filter: string }) {
  const repos = useQuery(reposQuery);
  const agents = useQuery(agentsQuery);
  const now = useNow();
  const repoNames = useMemo(
    () => new Map((repos.data ?? []).map((repo) => [repo.id, repo.name])),
    [repos.data],
  );
  const library = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const groups = groupTasks(tasks.filter((task) => matchesFilter(task, filter)));

  if (tasks.length === 0) {
    return <Message title="The wall is quiet">Tasks you start show up here.</Message>;
  }
  if (GROUPS.every((g) => groups[g.key].length === 0)) {
    return <Message title="No tasks match">Nothing matches “{filter.trim()}”.</Message>;
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
                  clis={agentClis(task.agents, library)}
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

function LiveIndicator() {
  const status = useLiveStatus();
  return (
    <span className="inline-flex items-center gap-1.5" role="status">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          status === "open" ? "bg-done" : "animate-blink-needs bg-interrupted",
        )}
      />
      {LIVE_LABELS[status]}
    </span>
  );
}

/** Left pane: the task inbox, grouped needs you → running → recent. */
export function Inbox() {
  const tasks = useQuery(tasksQuery);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const needs = needsYouCount(tasks.data ?? []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isPlainKey(event) || isTypingTarget(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        filterInput.current?.focus();
      } else if (event.key.toLowerCase() === "n" && !document.querySelector("[role=dialog]")) {
        event.preventDefault();
        setCreating(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <aside
      aria-label="Task inbox"
      className="flex h-full w-[352px] min-w-0 shrink-0 flex-col border-r border-border bg-sidebar"
    >
      <div className="flex flex-col gap-2.5 border-b border-border py-3 pr-3 pl-3.5">
        <div className="flex h-7 items-center gap-2">
          <WordmarkLink />
          {needs > 0 && (
            <StatusBadge status="needs-you" label={`${needs} need you`} className="ml-1" />
          )}
          <QuotaChip />
          <span className="flex-1" />
          <ThemeToggle />
          <Button variant="ghost" size="icon" asChild>
            <Link to="/settings" aria-label="Settings">
              <GearIcon />
            </Link>
          </Button>
        </div>
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
        <Message title="Loading tasks…" />
      ) : tasks.isError ? (
        <Message title="Could not load tasks">
          {tasks.error.message}{" "}
          <Button variant="ghost" size="sm" onClick={() => void tasks.refetch()}>
            Retry
          </Button>
        </Message>
      ) : (
        <TaskList tasks={tasks.data} filter={filter} />
      )}

      <BacklogNav />

      <div className="flex items-center gap-2.5 border-t border-border px-3.5 py-2 text-label text-muted-foreground">
        <LiveIndicator />
      </div>
      <NewTaskModal open={creating} onClose={() => setCreating(false)} />
    </aside>
  );
}

function WordmarkLink() {
  return (
    <Link to="/" aria-label="blackwall inbox" className="no-underline hover:no-underline">
      <Wordmark />
    </Link>
  );
}
