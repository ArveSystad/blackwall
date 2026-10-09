import { MAX_FIX_ROUNDS, type Agent, type Task } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { originKey, relativeTime } from "../../inbox";
import { agentsQuery, connectionsQuery, reposQuery } from "../../query";
import { canStop, deleteBlockedReason, originUrl, taskAgentIds } from "../../task-view";
import { AgentTile } from "../AgentTile";
import {
  BranchIcon,
  JiraIcon,
  PullRequestIcon,
  RepoIcon,
  StopIcon,
  TextIcon,
  TrashIcon,
} from "../icons";
import { StageStepper } from "../StageStepper";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { stop } from "./actions";
import type { TaskAction } from "./use-task-action";

const MODE_LABELS = { work: "Work on PR", review: "Review PR" } as const;
const ORIGIN_ICONS = {
  "jira-issue": JiraIcon,
  "github-pr": PullRequestIcon,
  "free-text": TextIcon,
} as const;

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
 * Task header: origin, title, repo, branch, agents and the stage stepper with
 * the review round, plus Stop (while queued or running) and Delete (until
 * something was delivered).
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
  const repos = useQuery(reposQuery);
  const connections = useQuery(connectionsQuery);
  const agents = useQuery(agentsQuery);
  const agentMap = new Map((agents.data ?? []).map((a) => [a.id, a]));
  const repo = repos.data?.find((r) => r.id === task.repoId);
  const url = originUrl(task, connections.data ?? []);
  const OriginIcon = ORIGIN_ICONS[task.origin.kind];
  const kindLabel =
    task.origin.kind === "jira-issue"
      ? "Jira"
      : task.origin.kind === "github-pr"
        ? task.mode
          ? MODE_LABELS[task.mode]
          : "Pull request"
        : "Free text";
  const inReview = task.stage === "code-review" || task.stage === "aggregate";

  return (
    <header className="flex flex-col gap-2 border-b border-border bg-sidebar px-5 pt-3.5 pb-3">
      <div className="flex items-center gap-2 text-meta">
        <OriginIcon size="sm" className="text-muted-foreground" />
        {url ? (
          <a className="mono" href={url} target="_blank" rel="noreferrer">
            {originKey(task)}
          </a>
        ) : (
          <span className="mono text-muted-foreground">{originKey(task)}</span>
        )}
        <span className="inline-flex h-5 items-center rounded-sm border border-border-strong px-1.5 text-[11.5px] font-medium text-muted-foreground">
          {kindLabel}
        </span>
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
      <h1 className="m-0 text-title font-semibold tracking-[-0.01em] text-foreground-strong">
        {task.title}
      </h1>
      <div className="flex flex-wrap items-center gap-3.5 text-meta text-muted-foreground">
        {repo && (
          <span className="inline-flex items-center gap-[5px]">
            <RepoIcon size="sm" />
            <span className="mono">{repo.name}</span>
          </span>
        )}
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
    </header>
  );
}
