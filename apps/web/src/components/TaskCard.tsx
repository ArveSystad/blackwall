import { ciNeedsYou, type AgentCli, type AgentTrust, type Task } from "@blackwall/shared";
import { Link } from "@tanstack/react-router";
import { useState, type CSSProperties } from "react";
import type { Crumble } from "../crumble";
import { originKey, relativeTime, statusLabel } from "../inbox";
import { cn } from "../lib/utils";
import { canArchive, CI_FAILED_REASON, GATE_REASONS } from "../task-view";
import { AgentTile } from "./AgentTile";
import { CiBadge } from "./CiBadge";
import { DecryptGlyphs } from "./DecryptText";
import { ArchiveIcon, TrashIcon, WarnIcon } from "./icons";
import { ORIGIN_ICONS } from "./origins";
import { StagePips } from "./StagePips";
import { StatusBadge } from "./StatusBadge";
import { TrustBadge } from "./TrustBadge";
import { DeleteTaskDialog } from "./task/DeleteTaskDialog";
import { Button } from "./ui/button";
import { useEncrypt } from "./use-decrypt";

/**
 * Inbox card linking to the task. Needs-you tasks, and done tasks whose CI
 * failed, get the magenta rail and wash, and say why they wait unless they
 * are finishing (delivering), when the pill reads "Finishing". A task that
 * pushed shows its CI as a small badge, and one whose agents run above Locked, or are forced
 * Locked, shows their trust. Tasks show a delete button on hover or focus,
 * in place of the time, and done or archivable tasks an archive button next
 * to it. An archived row crumbles out (`.bw-crumble`): its title scrambles
 * into glyphs, then the row flickers and falls; a failed archive flashes it red.
 */
export function TaskCard({
  task,
  repoName,
  clis = [],
  trust,
  now,
  crumble,
  onArchive,
}: {
  task: Task;
  repoName?: string;
  /** The CLIs of the task's agents, one tile each. */
  clis?: readonly AgentCli[];
  /** The trust the task's agents run under; nothing shows for a simply Locked repo. */
  trust?: AgentTrust;
  now: Date;
  /** The row's archive crumble, while it plays or its failure flashes. */
  crumble?: Crumble | undefined;
  /** Archives the task; the archive button shows only with it. */
  onArchive?: () => void;
}) {
  const OriginIcon = ORIGIN_ICONS[task.origin.kind];
  const ciFailed = ciNeedsYou(task);
  const needsYou = task.status === "needs-you" || ciFailed;
  const [deleting, setDeleting] = useState(false);
  const crumbling = crumble?.phase === "crumbling";
  const crumbleFrame = useEncrypt(task.title, crumbling, crumble?.delayMs ?? 0);
  return (
    <div
      className={cn("group relative isolate", crumbling && "bw-crumble")}
      style={
        crumbling ? ({ "--crumble-delay": `${crumble.delayMs}ms` } as CSSProperties) : undefined
      }
      inert={crumbling}
    >
      {/* The wash is translucent, so the open needs-you card glows from a halo sibling. */}
      {needsYou && (
        <span
          aria-hidden="true"
          className="bw-chamfer-halo bw-chamfer-halo-glow-needs hidden group-has-[a[data-status=active]]:block"
        />
      )}
      <Link
        to="/tasks/$taskId"
        params={{ taskId: task.id }}
        className={cn(
          "bw-chamfer bw-chamfer-focus flex flex-col gap-[5px] py-[9px] pr-3 pl-3.5 text-foreground no-underline [--bw-chamfer-line:transparent] hover:bg-card hover:no-underline",
          "data-[status=active]:bg-muted data-[status=active]:[--bw-chamfer-line:var(--border-strong)]",
          needsYou &&
            "bg-needs-wash [--bw-chamfer-line:color-mix(in_oklab,var(--magenta)_30%,transparent)] hover:bg-needs-wash data-[status=active]:bg-needs-wash data-[status=active]:[--bw-chamfer-line:var(--magenta)]",
          needsYou &&
            "before:absolute before:top-2.5 before:bottom-2.5 before:left-[5px] before:w-[3px] before:bg-magenta before:shadow-glow-rail",
        )}
      >
        <span className="flex h-4 items-center gap-1.5">
          <OriginIcon size="sm" className="text-muted-foreground" />
          <span className="mono text-[11.5px] text-muted-foreground">{originKey(task)}</span>
          <span className="flex-1" />
          <time
            className="text-label text-faint group-focus-within:invisible group-hover:invisible"
            dateTime={task.updatedAt.toISOString()}
          >
            {relativeTime(task.updatedAt, now)}
          </time>
        </span>
        <span
          className={cn(
            "text-body leading-[18px] font-medium text-foreground-strong",
            !crumbling && "line-clamp-2",
            task.status === "done" && "font-normal text-foreground",
          )}
        >
          {crumbling ? (
            <DecryptGlyphs text={task.title} frame={crumbleFrame} className="bw-decrypt-clip" />
          ) : (
            task.title
          )}
        </span>
        {needsYou && task.gate && !task.delivering && (
          <span className="flex items-center gap-1.5 text-meta font-medium text-magenta">
            <WarnIcon size="sm" />
            {GATE_REASONS[task.gate]}
          </span>
        )}
        {ciFailed && (
          <span className="flex items-center gap-1.5 text-meta font-medium text-magenta">
            <WarnIcon size="sm" />
            {CI_FAILED_REASON}
          </span>
        )}
        {trust && <TrustBadge trust={trust} className="self-start" />}
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
          {task.ci && <CiBadge ci={task.ci} compact />}
          <StatusBadge status={task.status} label={statusLabel(task)} />
        </span>
      </Link>
      <span className="invisible absolute top-1 right-1.5 flex gap-0.5 group-focus-within:visible group-hover:visible">
        {onArchive && canArchive(task) && (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onArchive}
            aria-label={`Archive ${task.title}`}
            title="Archive task"
          >
            <ArchiveIcon size="sm" />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          className="hover:text-destructive"
          onClick={() => setDeleting(true)}
          aria-label={`Delete ${task.title}`}
          title="Delete task"
        >
          <TrashIcon size="sm" />
        </Button>
      </span>
      {crumble?.phase === "failed" && (
        <span
          key={`crumble-failed:${crumble.failures}`}
          aria-hidden="true"
          className="bw-crumble-failed pointer-events-none absolute inset-0"
        />
      )}
      {deleting && <DeleteTaskDialog task={task} onClose={() => setDeleting(false)} />}
    </div>
  );
}
