import {
  isGatingSeverity,
  type Agent,
  type Finding,
  type FindingOverride,
} from "@blackwall/shared";
import { cn } from "../lib/utils";
import { findingLocation, looksLikeDiff, parseDiff } from "../task-view";
import { AgentTile } from "./AgentTile";
import { DiffView } from "./DiffView";
import { ChevronRightIcon, LockIcon } from "./icons";
import { SeverityChip } from "./SeverityChip";
import { Button } from "./ui/button";
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
  onOverride: (status: FindingOverride) => void;
}) {
  switch (finding.status) {
    case "fixed":
      return (
        <span className="inline-flex h-5 items-center rounded-sm border border-done/40 px-1.5 text-[11.5px] font-medium text-done">
          Fixed · r{finding.round}
        </span>
      );
    case "force-fix":
      return (
        <>
          <span className="inline-flex h-5 items-center rounded-sm border border-cyan/45 px-1.5 text-[11.5px] font-medium text-cyan">
            Force fix
          </span>
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
          <span className="inline-flex h-5 items-center rounded-sm border border-border-strong px-1.5 text-[11.5px] font-medium text-muted-foreground">
            Ignored
          </span>
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

/** One review finding (`.frow`); expands to why, the suggested fix, and Force fix / Force ignore. */
export function FindingRow({
  finding,
  reviewer,
  expanded,
  pending,
  onToggle,
  onOverride,
}: {
  finding: Finding;
  reviewer: Agent | undefined;
  expanded: boolean;
  pending: boolean;
  onToggle: () => void;
  onOverride: (status: FindingOverride) => void;
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
            <span
              key={tag}
              className="inline-flex h-[18px] flex-none items-center rounded-xs bg-muted px-[5px] font-mono text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </span>
        <span
          role="cell"
          className="flex min-w-0 items-center gap-1.5 text-meta whitespace-nowrap text-muted-foreground"
        >
          {reviewer ? (
            <>
              <AgentTile cli={reviewer.cli} />
              <span className="truncate">{reviewer.name}</span>
            </>
          ) : (
            <span className="truncate">Checks</span>
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
              finding.status === "force-ignore") && (
              <div className="mt-1 flex gap-1.5">
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
              <pre className="m-0 overflow-x-auto rounded-md border border-border bg-code px-3 py-2 font-mono text-code whitespace-pre-wrap text-foreground">
                {fix}
              </pre>
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
