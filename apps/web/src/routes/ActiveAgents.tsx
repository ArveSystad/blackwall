import type { ActiveAgentStep, Agent, Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { AgentTile } from "../components/AgentTile";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { useAgentLibrary, useNow } from "../hooks";
import { originKey, relativeTime } from "../inbox";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import { activeAgentsQuery, reposQuery, stepEventsQuery, tasksQuery } from "../query";
import {
  AUTO_MODEL_LABEL,
  STAGE_LABELS,
  currentActivity,
  effectiveModel,
  modelTitle,
} from "../task-view";

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
  const { model, source } = effectiveModel(events.data, agent, step.cli);
  const since = step.startedAt ?? step.createdAt;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3.5 py-2.5">
      <span className="flex h-5 items-center gap-2">
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse-running rounded-full bg-running"
        />
        {step.cli && <AgentTile cli={step.cli} />}
        <span className="font-medium text-foreground-strong">{agent?.name ?? "Deleted agent"}</span>
        <span
          className="mono max-w-40 truncate text-label text-muted-foreground"
          title={modelTitle({ model, source })}
        >
          {model ?? AUTO_MODEL_LABEL}
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
  const navigate = useNavigate();
  const active = useQuery(activeAgentsQuery);
  const tasks = useQuery(tasksQuery);
  const library = useAgentLibrary();
  const repos = useQuery(reposQuery);
  const now = useNow();
  const taskById = useMemo(
    () => new Map((tasks.data ?? []).map((task) => [task.id, task])),
    [tasks.data],
  );
  const repoNames = useMemo(
    () => new Map((repos.data ?? []).map((repo) => [repo.id, repo.name])),
    [repos.data],
  );

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={cn(paneHeader, "bg-sidebar")}>
        <h1 className={paneTitle}>Active agents</h1>
        {active.data && (
          <span className="mono text-label text-faint">{active.data.length} running</span>
        )}
      </div>

      <div className={paneBody}>
        {active.isPending ? (
          <EmptyState key="loading" role="status" title="Polling agents…" />
        ) : active.isError ? (
          <EmptyState
            key="error"
            role="alert"
            title="Could not load agents"
            onRetry={() => void active.refetch()}
          >
            {active.error.message}
          </EmptyState>
        ) : active.data.length === 0 ? (
          <EmptyState key="empty" title="All agents idle.">
            Agents show up here while a task is in a stage they work on.
          </EmptyState>
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
