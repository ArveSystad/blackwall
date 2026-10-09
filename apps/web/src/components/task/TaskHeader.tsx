import { MAX_FIX_ROUNDS, type Agent, type Task } from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { originKey, relativeTime } from "../../inbox";
import { useAgentLibrary } from "../../hooks";
import { connectionsQuery, queryKeys, reposQuery } from "../../query";
import { canArchive, canStop, deleteBlockedReason, originUrl, taskAgentIds } from "../../task-view";
import { AgentTile } from "../AgentTile";
import { BacklogIcon, BranchIcon, ChevronRightIcon, StopIcon, TrashIcon } from "../icons";
import { ORIGIN_ICONS, PR_MODE_LABELS } from "../origins";
import { StageStepper } from "../StageStepper";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Chip } from "../ui/chip";
import { Kbd } from "../ui/kbd";
import { archive, stop, unarchive } from "./actions";
import type { TaskAction } from "./use-task-action";

function AgentSummary({ task, agents }: { task: Task; agents: ReadonlyMap<string, Agent> }) {
  const ids = taskAgentIds(task.agents);
  if (ids.length === 0) return null;
  const tiles = ids.flatMap((id) => {
    const agent = agents.get(id);
    return agent ? [agent] : [];
  });
  const reviewers = new Set([
    ...(task.agents.planReviewers ?? []),
    ...(task.agents.codeReviewers ?? []),
  ]);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        {[...new Set(tiles.map((a) => a.cli))].map((cli) => (
          <AgentTile key={cli} cli={cli} />
        ))}
      </span>
      {tiles.length} {tiles.length === 1 ? "agent" : "agents"}
      {reviewers.size > 0 &&
        `, ${reviewers.size} ${reviewers.size === 1 ? "reviewer" : "reviewers"}`}
    </span>
  );
}

function startedLabel(date: Date): string {
  const ago = relativeTime(date);
  if (ago === "now") return "Started just now";
  if (ago === "yday") return "Started yesterday";
  return `Started ${ago} ago`;
}

/**
 * Task header: origin, title with a breadcrumb back to the repo's backlog,
 * branch, agents and the stage stepper with the review round, plus Stop
 * (while queued or running), Archive (when done), Unarchive (when archived)
 * and Delete (until something was delivered).
 * While running, a cyan stream sweeps along the bottom border.
 */
export function TaskHeader({
  task,
  round,
  action,
  onDelete,
}: {
  task: Task;
  round: number;
  action: TaskAction;
  onDelete: () => void;
}) {
  const blocked = deleteBlockedReason(task);
  const queryClient = useQueryClient();
  const repos = useQuery(reposQuery);
  const connections = useQuery(connectionsQuery);
  const agentMap = useAgentLibrary();
  const repo = repos.data?.find((r) => r.id === task.repoId);
  const url = originUrl(task, connections.data ?? []);
  const OriginIcon = ORIGIN_ICONS[task.origin.kind];
  const kindLabel =
    task.origin.kind === "jira-issue"
      ? "Jira"
      : task.origin.kind === "github-pr"
        ? task.mode
          ? PR_MODE_LABELS[task.mode]
          : "Pull request"
        : "Free text";
  const inReview = task.stage === "code-review" || task.stage === "aggregate";

  async function setArchived(archived: boolean) {
    try {
      await (archived ? archive(action, task) : unarchive(action, task));
    } finally {
      // The task.upserted event may arrive after the response.
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
    }
  }

  return (
    <header className="relative flex flex-col gap-2 border-b border-border bg-sidebar px-5 pt-3.5 pb-3">
      <div className="flex items-center gap-2 text-meta">
        <OriginIcon size="sm" className="text-muted-foreground" />
        {url ? (
          <a className="mono" href={url} target="_blank" rel="noreferrer">
            {originKey(task)}
          </a>
        ) : (
          <span className="mono text-muted-foreground">{originKey(task)}</span>
        )}
        <Chip tone="neutral">{kindLabel}</Chip>
        <span className="text-faint">·</span>
        <time className="text-muted-foreground" dateTime={task.createdAt.toISOString()}>
          {startedLabel(task.createdAt)}
        </time>
        <span className="flex-1" />
        {canStop(task) && (
          <Button
            size="sm"
            disabled={action.pending}
            onClick={() => void stop(action, task)}
            aria-keyshortcuts="S"
          >
            <StopIcon size="sm" />
            Stop
            <Kbd>S</Kbd>
          </Button>
        )}
        {canArchive(task) && (
          <Button
            size="sm"
            variant="ghost"
            title="Move the task to the repo's archive"
            disabled={action.pending}
            onClick={() => void setArchived(true)}
          >
            Archive
          </Button>
        )}
        {task.archivedAt !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={action.pending}
            onClick={() => void setArchived(false)}
          >
            Unarchive
          </Button>
        )}
        {/* A disabled button shows no tooltip of its own, so the wrapper carries why. */}
        <span title={blocked ?? "Delete task"} className="inline-flex">
          <Button
            size="icon-sm"
            variant="ghost"
            className="hover:text-destructive"
            disabled={blocked !== null}
            onClick={onDelete}
            aria-label={blocked ? `Delete task: ${blocked}` : "Delete task"}
          >
            <TrashIcon size="sm" />
          </Button>
        </span>
        <StatusBadge status={task.status} />
      </div>
      <div className="flex items-baseline gap-1.5">
        {repo?.exists && (
          <nav aria-label="Breadcrumb" className="flex max-w-[40%] shrink-0 items-center gap-1.5">
            <Link
              to="/repos/$repoId/backlog"
              params={{ repoId: repo.id }}
              aria-label={`${repo.name} backlog`}
              className="inline-flex min-w-0 items-center gap-1 text-meta text-muted-foreground no-underline hover:text-foreground hover:underline focus-visible:shadow-ring focus-visible:outline-none"
            >
              <BacklogIcon size="sm" className="shrink-0" />
              <span className="mono truncate">{repo.name}</span>
            </Link>
            <ChevronRightIcon size="sm" className="shrink-0 text-faint" aria-hidden />
          </nav>
        )}
        <h1 className="m-0 min-w-0 text-title font-semibold tracking-[-0.01em] text-foreground-strong">
          {task.title}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-meta text-muted-foreground">
        {task.branch && (
          <span className="inline-flex items-center gap-[5px]">
            <BranchIcon size="sm" />
            <span className="mono text-foreground">{task.branch}</span>
          </span>
        )}
        <AgentSummary task={task} agents={agentMap} />
      </div>
      <div className="mt-1">
        <StageStepper
          task={task}
          detail={
            inReview && task.mode !== "review" && round > 0 ? (
              <span className="mono ml-1 text-[11px] font-normal text-faint">
                fix round {round}/{MAX_FIX_ROUNDS}
              </span>
            ) : undefined
          }
        />
      </div>
      {task.status === "running" && (
        <span aria-hidden="true" className="bw-stream absolute inset-x-0 -bottom-px" />
      )}
    </header>
  );
}
