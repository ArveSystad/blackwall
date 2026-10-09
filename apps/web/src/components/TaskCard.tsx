import type { AgentCli, Task } from "@blackwall/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { originKey, relativeTime } from "../inbox";
import { cn } from "../lib/utils";
import { deleteBlockedReason, GATE_REASONS } from "../task-view";
import { AgentTile } from "./AgentTile";
import { TrashIcon, WarnIcon } from "./icons";
import { ORIGIN_ICONS } from "./origins";
import { StagePips } from "./StagePips";
import { StatusBadge } from "./StatusBadge";
import { DeleteTaskDialog } from "./task/DeleteTaskDialog";
import { Button } from "./ui/button";

/**
 * Inbox card linking to the task. Needs-you tasks get the magenta rail and
 * wash, and say why they wait. Undelivered tasks show a delete button on
 * hover or focus, in place of the time.
 */
export function TaskCard({
  task,
  repoName,
  clis = [],
  now,
}: {
  task: Task;
  repoName?: string;
  /** The CLIs of the task's agents, one tile each. */
  clis?: readonly AgentCli[];
  now: Date;
}) {
  const OriginIcon = ORIGIN_ICONS[task.origin.kind];
  const needsYou = task.status === "needs-you";
  const deletable = deleteBlockedReason(task) === null;
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="group relative">
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        className={cn(
          "relative flex flex-col gap-[5px] rounded-lg border border-transparent py-[9px] pr-3 pl-3.5 text-foreground no-underline hover:bg-card hover:no-underline",
          "data-[status=active]:bg-muted data-[status=active]:border-border-strong",
          needsYou &&
            "border-magenta/30 bg-needs-wash hover:bg-needs-wash data-[status=active]:border-magenta data-[status=active]:bg-needs-wash data-[status=active]:shadow-glow-needs",
          needsYou &&
            "before:absolute before:top-2.5 before:bottom-2.5 before:left-[5px] before:w-[3px] before:rounded-[2px] before:bg-magenta before:shadow-glow-rail",
        )}
      >
        <span className="flex h-4 items-center gap-1.5">
          <OriginIcon size="sm" className="text-muted-foreground" />
          <span className="mono text-[11.5px] text-muted-foreground">{originKey(task)}</span>
          <span className="flex-1" />
          <time
            className={cn(
              "text-label text-faint",
              deletable && "group-focus-within:invisible group-hover:invisible",
            )}
            dateTime={task.updatedAt.toISOString()}
          >
            {relativeTime(task.updatedAt, now)}
          </time>
        </span>
        <span
          className={cn(
            "line-clamp-2 text-body leading-[18px] font-medium text-foreground-strong",
            task.status === "done" && "font-normal text-foreground",
          )}
        >
          {task.title}
        </span>
        {needsYou && task.gate && (
          <span className="flex items-center gap-1.5 text-meta font-medium text-magenta">
            <WarnIcon size="sm" />
            {GATE_REASONS[task.gate]}
          </span>
        )}
        <span className="mt-px flex items-center gap-2">
          {repoName && (
            <span className="mono max-w-24 truncate text-label text-faint">{repoName}</span>
          )}
          <StagePips task={task} />
          <span className="flex-1" />
          {clis.length > 0 && (
            <span className="inline-flex gap-[3px]">
              {clis.map((cli) => (
                <AgentTile key={cli} cli={cli} />
              ))}
            </span>
          )}
          <StatusBadge status={task.status} />
        </span>
      </Link>
      {deletable && (
        <Button
          size="icon-sm"
          variant="ghost"
          className="invisible absolute top-1 right-1.5 group-focus-within:visible group-hover:visible hover:text-destructive"
          onClick={() => setDeleting(true)}
          aria-label={`Delete ${task.title}`}
          title="Delete task"
        >
          <TrashIcon size="sm" />
        </Button>
      )}
      {deleting && <DeleteTaskDialog task={task} onClose={() => setDeleting(false)} />}
    </div>
  );
}
