import type { ActiveAgentStep, Agent, Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AgentTile } from "../components/AgentTile";
import { WallIcon } from "../components/icons";
import { Button } from "../components/ui/button";
import { originKey, relativeTime } from "../inbox";
import { activeAgentsQuery, agentsQuery, reposQuery, stepEventsQuery, tasksQuery } from "../query";
import { STAGE_LABELS, currentActivity, stepModel } from "../task-view";

/** Re-renders every minute so elapsed times stay current. */
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
      {children && <div className="max-w-80 text-meta text-muted-foreground">{children}</div>}
    </div>
  );
}

/** One running agent: who it is, the model, the stage, what it is doing now and the task it works on. */
function AgentRow({
  step,
  agent,
  task,
  repoName,
  now,
}: {
  step: ActiveAgentStep;
  agent: Agent | undefined;
  task: Task | undefined;
  repoName: string | undefined;
  now: Date;
}) {
  const events = useQuery(stepEventsQuery(step.taskId, step.id));
  const activity = events.data ? currentActivity(events.data) : null;
  const model = (events.data && stepModel(events.data)) ?? agent?.model ?? null;
  const since = step.startedAt ?? step.createdAt;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
      <span className="flex h-5 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse-running rounded-full bg-running"
        />
        {agent && <AgentTile cli={agent.cli} />}
        <span className="font-medium text-foreground-strong">{agent?.name ?? "Deleted agent"}</span>
        <span
          className="mono max-w-40 truncate text-label text-muted-foreground"
          title={model ?? undefined}
        >
          {model ?? "CLI default"}
        </span>
        <span className="label text-cyan">{STAGE_LABELS[step.stage]}</span>
        {step.round > 0 && <span className="mono text-label text-faint">round {step.round}</span>}
        <span className="flex-1" />
        <time className="text-label text-faint" dateTime={since.toISOString()}>
          {relativeTime(since, now)}
        </time>
      </span>
      <span className="mono truncate text-meta text-foreground" title={activity ?? undefined}>
        {activity ?? "Starting…"}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-meta">
        {task ? (
          <Link
            to="/tasks/$taskId"
            params={{ taskId: task.id }}
            className="min-w-0 truncate text-foreground-strong"
          >
            {task.title}
          </Link>
        ) : (
          <span className="text-muted-foreground">Unknown task</span>
        )}
        {task && <span className="mono text-label text-muted-foreground">{originKey(task)}</span>}
        {repoName && (
          <span className="mono max-w-24 truncate text-label text-faint">{repoName}</span>
        )}
      </span>
    </li>
  );
}

/** Every running agent across all tasks, oldest first, updated live. */
export function ActiveAgents() {
  const active = useQuery(activeAgentsQuery);
  const tasks = useQuery(tasksQuery);
  const agents = useQuery(agentsQuery);
  const repos = useQuery(reposQuery);
  const now = useNow();
  const taskById = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.id, task])),
    [tasks.data],
  );
  const library = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const repoNames = useMemo(
    () => new Map((repos.data ?? []).map((repo) => [repo.id, repo.name])),
    [repos.data],
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-[52px] items-center gap-2.5 border-b border-border bg-sidebar px-5 py-3">
        <h1 className="m-0 text-heading font-semibold text-foreground-strong">Active agents</h1>
        {active.data && (
          <span className="mono text-label text-faint">{active.data.length} running</span>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
        {active.isPending ? (
          <Message title="Loading agents…" />
        ) : active.isError ? (
          <Message title="Could not load agents">
            {active.error.message}{" "}
            <Button variant="ghost" size="sm" onClick={() => void active.refetch()}>
              Retry
            </Button>
          </Message>
        ) : active.data.length === 0 ? (
          <Message title="No agents running">
            Agents show up here while a task is in a stage they work on.
          </Message>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Active agents">
            {active.data.map((step) => {
              const task = taskById.get(step.taskId);
              return (
                <AgentRow
                  key={step.id}
                  step={step}
                  agent={step.agentId ? library.get(step.agentId) : undefined}
                  task={task}
                  repoName={task && repoNames.get(task.repoId)}
                  now={now}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
