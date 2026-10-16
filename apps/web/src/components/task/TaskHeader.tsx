import {
  MAX_FIX_ROUNDS,
  effectiveTrust,
  type Agent,
  type Step,
  type Task,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { originKey, relativeTime, statusLabel } from "../../inbox";
import { useAgentLibrary } from "../../hooks";
import { connectionsQuery, queryKeys, reposQuery, usageQuery } from "../../query";
import { TRUST_NAMES, otherTrustLevels } from "../../trust";
import { formatCost, formatTokens, sumUsage, usageTitle } from "../../usage";
import {
  agentClis,
  canArchive,
  canStop,
  deleteBlockedReason,
  originUrl,
  taskAgentIds,
} from "../../task-view";
import { AgentTile } from "../AgentTile";
import { CiBadge } from "../CiBadge";
import { DecryptText } from "../DecryptText";
import { BacklogIcon, BranchIcon, ChevronRightIcon, StopIcon, TrashIcon } from "../icons";
import { ORIGIN_ICONS, PR_MODE_LABELS } from "../origins";
import { StageStepper } from "../StageStepper";
import { StatusBadge } from "../StatusBadge";
import { TrustBadge } from "../TrustBadge";
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
        {agentClis(task).map((cli) => (
          <AgentTile key={cli} cli={cli} />
        ))}
      </span>
      {tiles.length} {tiles.length === 1 ? "agent" : "agents"}
      {reviewers.size > 0 &&
        `, ${reviewers.size} ${reviewers.size === 1 ? "reviewer" : "reviewers"}`}
    </span>
  );
}

/** The tokens and cost the task's agents used so far; nothing before any usage is reported. */
function UsageChip({ taskId }: { taskId: string }) {
  const usage = useQuery(usageQuery);
  const rows = usage.data?.filter((row) => row.taskId === taskId) ?? [];
  if (rows.length === 0) return null;
  const total = sumUsage(rows);
  return (
    <Chip tone="neutral" title={usageTitle(total)}>
      <span className="mono">
        {formatTokens(total.tokens)} tokens · {formatCost(total)}
      </span>
    </Chip>
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
 * branch, agents, the tokens and cost used so far, the agents' trust (with a note when steps of
 * the latest run ran at another level), and the stage stepper with the review round, plus Stop
 * (while queued, running or waiting on you), Archive (when done), Unarchive (when archived)
 * and Delete (until something was delivered).
 * While running, a cyan stream sweeps along the bottom border. Corner brackets frame it and turn
 * cyan while anything inside has focus.
 */
export function TaskHeader({
  task,
  round,
  steps,
  action,
  onDelete,
}: {
  task: Task;
  round: number;
  /** The latest run's steps, for the levels its agents ran under. */
  steps: readonly Step[];
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
        : task.origin.kind === "github-issue"
          ? "GitHub issue"
          : "Blackwall";
  const inReview = task.stage === "code-review" || task.stage === "aggregate";
  const trust = repo ? effectiveTrust(repo, task) : undefined;
  const otherLevels = trust ? otherTrustLevels(steps, trust) : [];

  async function setArchived(archived: boolean) {
    try {
      await (archived ? archive(action, task) : unarchive(action, task));
    } finally {
      // The task.upserted event may arrive after the response.
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks, exact: true });
    }
  }

  return (
    <header className="bw-brackets relative flex flex-col gap-2 border-b border-border bg-sidebar px-5 pt-3.5 pb-3">
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
        <StatusBadge status={task.status} label={statusLabel(task)} />
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
          <DecryptText text={task.title} trigger={task.id} className="bw-decrypt-clip" />
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-3.5 text-meta text-muted-foreground">
        {task.branch && (
          <span className="inline-flex items-center gap-[5px]">
            <BranchIcon size="sm" />
            <span className="mono text-foreground">{task.branch}</span>
          </span>
        )}
        {task.ci && <CiBadge ci={task.ci} />}
        <AgentSummary task={task} agents={agentMap} />
        <UsageChip taskId={task.id} />
        {trust && <TrustBadge trust={trust} />}
        {otherLevels.length > 0 && (
          <span className="text-faint">
            Earlier steps ran {otherLevels.map((level) => TRUST_NAMES[level]).join(" and ")}
          </span>
        )}
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
