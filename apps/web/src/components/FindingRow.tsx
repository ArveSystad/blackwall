import {
  isGatingSeverity,
  isUserComment,
  type Agent,
  type AgentCli,
  type Finding,
  type FindingOverride,
} from "@blackwall/shared";
import { cn } from "../lib/utils";
import { findingLocation, looksLikeDiff, parseDiff } from "../task-view";
import { AgentTile } from "./AgentTile";
import { DiffView } from "./DiffView";
import { codeBlock } from "./classes";
import { ChevronRightIcon, LockIcon } from "./icons";
import { SeverityChip } from "./SeverityChip";
import { Button } from "./ui/button";
import { Chip, Tag } from "./ui/chip";
import { Kbd } from "./ui/kbd";

export const FINDING_GRID =
  "grid grid-cols-[22px_92px_minmax(240px,1fr)_150px_210px_190px] items-center gap-3 px-4";

function Triage({
  finding,
  pending,
  onOverride,
}: {
  finding: Finding;
  pending: boolean;
  onOverride?: ((status: FindingOverride) => void) | undefined;
}) {
  if (finding.status === "fixed") return <Chip tone="done">Fixed · r{finding.round}</Chip>;
  if (!onOverride) {
    if (finding.status === "force-fix") return <Chip tone="cyan">Force fix</Chip>;
    if (finding.status === "force-ignore") return <Chip tone="neutral">Ignored</Chip>;
    return null;
  }
  switch (finding.status) {
    case "force-fix":
      return (
        <>
          <Chip tone="cyan">Force fix</Chip>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onOverride("force-ignore")}
          >
            Ignore
          </Button>
        </>
      );
    case "force-ignore":
      return (
        <>
          <Chip tone="neutral">Ignored</Chip>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onOverride("force-fix")}
          >
            Fix
          </Button>
        </>
      );
    default:
      return (
        <>
          <Button size="sm" disabled={pending} onClick={() => onOverride("force-fix")}>
            Force fix
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => onOverride("force-ignore")}
          >
            Force ignore
          </Button>
        </>
      );
  }
}

/**
 * One review finding (`.frow`); expands to why, the suggested fix, and Force
 * fix / Force ignore when `onOverride` is given, plus Delete when `onDelete` is
 * given.
 */
export function FindingRow({
  finding,
  reviewer,
  cli,
  expanded,
  pending,
  onToggle,
  onOverride,
  onDelete,
}: {
  finding: Finding;
  reviewer: Agent | undefined;
  /** The CLI the reviewer ran on; null when unknown. */
  cli: AgentCli | null;
  expanded: boolean;
  pending: boolean;
  onToggle: () => void;
  /** Force fixes / force ignores the finding; only where overriding is allowed. */
  onOverride?: ((status: FindingOverride) => void) | undefined;
  /** Deletes the finding so it is not posted; only where deleting is allowed. */
  onDelete?: (() => void) | undefined;
}) {
  const gating = isGatingSeverity(finding.severity);
  const settled = finding.status === "force-ignore" || finding.status === "fixed";
  const location = findingLocation(finding);
  const fix = finding.suggestedFix?.trim();
  return (
    <div role="rowgroup">
      <div
        role="row"
        className={cn(
          FINDING_GRID,
          "h-10 border-b border-border hover:bg-card",
          expanded && "bg-card shadow-[inset_2px_0_0_var(--cyan)]",
        )}
      >
        <span role="cell" className="flex size-4 items-center justify-center text-magenta">
          {gating && <LockIcon size="sm" aria-label="Gates the review loop" role="img" />}
        </span>
        <span role="cell">
          <SeverityChip severity={finding.severity} />
        </span>
        <span role="cell" className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="flex min-w-0 cursor-pointer items-center gap-2 bg-transparent text-left"
          >
            <ChevronRightIcon size="sm" className={cn("text-faint", expanded && "rotate-90")} />
            <span
              className={cn(
                "truncate text-foreground-strong",
                settled && "text-faint line-through",
              )}
            >
              {finding.title}
            </span>
          </button>
          {finding.tags.slice(0, 2).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </span>
        <span
          role="cell"
          className="flex min-w-0 items-center gap-1.5 text-meta whitespace-nowrap text-muted-foreground"
        >
          {reviewer ? (
            <>
              {cli && <AgentTile cli={cli} />}
              <span className="truncate">{reviewer.name}</span>
            </>
          ) : (
            <span className="truncate">{isUserComment(finding) ? "You" : "Checks"}</span>
          )}
        </span>
        <span role="cell" className="mono truncate text-muted-foreground">
          {location ?? <span className="text-faint">no file</span>}
        </span>
        <span role="cell" className="flex justify-end gap-1">
          <Triage finding={finding} pending={pending} onOverride={onOverride} />
        </span>
      </div>
      {expanded && (
        <div
          role="row"
          className="grid grid-cols-1 gap-5 border-b border-border bg-card px-5 pt-3 pb-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:pl-[154px]"
        >
          <div role="cell" className="flex min-w-0 flex-col gap-2">
            <span className="label text-muted-foreground">Why</span>
            <p className="m-0 whitespace-pre-wrap text-foreground">{finding.explanation}</p>
            <p className="m-0 text-meta text-muted-foreground">
              Round {finding.round}
              {finding.tags.length > 0 && ` · ${finding.tags.join(", ")}`}
            </p>
            {(finding.status === "open" ||
              finding.status === "force-fix" ||
              finding.status === "force-ignore") &&
              (onOverride || onDelete) && (
                <div className="mt-1 flex gap-1.5">
                  {onOverride && (
                    <>
                      <Button
                        size="sm"
                        disabled={pending || finding.status === "force-fix"}
                        onClick={() => onOverride("force-fix")}
                      >
                        Force fix
                        <Kbd>F</Kbd>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || finding.status === "force-ignore"}
                        onClick={() => onOverride("force-ignore")}
                      >
                        Force ignore
                        <Kbd>I</Kbd>
                      </Button>
                    </>
                  )}
                  {onDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="hover:text-destructive"
                      disabled={pending}
                      title="Deletes this finding; it will not be posted"
                      onClick={onDelete}
                    >
                      Delete
                      <Kbd>D</Kbd>
                    </Button>
                  )}
                </div>
              )}
          </div>
          <div role="cell" className="flex min-w-0 flex-col gap-2">
            <span className="label text-muted-foreground">Suggested fix</span>
            {!fix ? (
              <p className="m-0 text-muted-foreground">The reviewer suggested no fix.</p>
            ) : looksLikeDiff(fix) ? (
              <DiffView lines={parseDiffLines(fix)} />
            ) : (
              <pre className={cn(codeBlock, "whitespace-pre-wrap")}>{fix}</pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** A suggested fix may be a bare hunk without a `diff --git` header. */
function parseDiffLines(text: string) {
  const withHeader = text.startsWith("diff --git ") ? text : `diff --git a/x b/x\n${text}`;
  return parseDiff(withHeader).flatMap((f) => f.lines);
}
