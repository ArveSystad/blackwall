import {
  SEVERITIES,
  agentCliFor,
  isGatingSeverity,
  type Finding,
  type FindingOverride,
  type Severity,
  type Step,
  type Task,
} from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteFinding, overrideFinding } from "../../api";
import { useAgentLibrary } from "../../hooks";
import { isPlainKey, isTypingTarget, useWindowKeydown } from "../../keyboard";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../query";
import { errorMessage } from "../../settings-forms";
import {
  SEVERITY_LABELS,
  canDeleteFinding,
  canOverrideFinding,
  severityCounts,
  sortFindings,
} from "../../task-view";
import { panelNote } from "../classes";
import { FINDING_GRID, FindingRow } from "../FindingRow";
import { ChevronRightIcon, LockIcon } from "../icons";
import { ErrorText } from "../ui/field";
import { SeverityChip } from "../SeverityChip";

/**
 * Review findings: filter by severity or gating, expand one for why and the
 * suggested fix, and, in a work task, force fix / force ignore it (F / I on the
 * open row). At review triage, unfixed findings can be deleted (D) so they are
 * not posted. Fixed findings fold into a collapsed list below the open ones.
 */
export function FindingsPanel({
  task,
  findings,
  steps = [],
}: {
  task: Task;
  findings: readonly Finding[];
  /** The latest run's steps, for the CLI each reviewer ran on. */
  steps?: readonly Step[];
}) {
  const queryClient = useQueryClient();
  const agentMap = useAgentLibrary();
  const [severities, setSeverities] = useState<ReadonlySet<Severity>>(new Set());
  const [gatingOnly, setGatingOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showFixed, setShowFixed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = severityCounts(findings);
  const shown = sortFindings(
    findings.filter(
      (f) =>
        (severities.size === 0 || severities.has(f.severity)) &&
        (!gatingOnly || isGatingSeverity(f.severity)),
    ),
  );
  const active = shown.filter((f) => f.status !== "fixed");
  const fixed = shown.filter((f) => f.status === "fixed");

  async function override(finding: Finding, status: FindingOverride) {
    setPending(finding.id);
    setError(null);
    try {
      const updated = await overrideFinding(task.id, finding.id, status);
      queryClient.setQueryData<Finding[]>(queryKeys.taskFindings(task.id), (list) =>
        list?.map((f) => (f.id === updated.id ? updated : f)),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  async function remove(finding: Finding) {
    setPending(finding.id);
    setError(null);
    try {
      const { deletedIds } = await deleteFinding(task.id, finding.id);
      const deleted = new Set(deletedIds);
      queryClient.setQueryData<Finding[]>(queryKeys.taskFindings(task.id), (list) =>
        list?.filter((f) => !deleted.has(f.id)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskDelivery(task.id) });
      setExpanded((id) => (id !== null && deleted.has(id) ? null : id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  }

  const overridable = canOverrideFinding(task);
  const open = findings.find((f) => f.id === expanded);
  useWindowKeydown(
    (event) => {
      if (!open || !isPlainKey(event) || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (overridable && key === "f" && open.status !== "force-fix") {
        event.preventDefault();
        void override(open, "force-fix");
      } else if (overridable && key === "i" && open.status !== "force-ignore") {
        event.preventDefault();
        void override(open, "force-ignore");
      } else if (key === "d" && canDeleteFinding(task, open)) {
        event.preventDefault();
        void remove(open);
      }
    },
    !!open && open.status !== "fixed",
  );

  function toggleSeverity(severity: Severity) {
    setSeverities((current) => {
      const next = new Set(current);
      if (next.has(severity)) next.delete(severity);
      else next.add(severity);
      return next;
    });
  }

  if (findings.length === 0) {
    return (
      <p className={panelNote}>
        {task.stage === "code-review" && task.status === "running"
          ? "The code reviewers are reading the diff."
          : "No findings. The code reviewers found nothing to report."}
      </p>
    );
  }

  const row = (finding: Finding) => (
    <FindingRow
      key={finding.id}
      finding={finding}
      reviewer={finding.reviewerAgentId ? agentMap.get(finding.reviewerAgentId) : undefined}
      cli={
        steps.find((s) => s.id === finding.stepId)?.cli ??
        (finding.reviewerAgentId ? agentCliFor(task, finding.reviewerAgentId) : null)
      }
      expanded={expanded === finding.id}
      pending={pending === finding.id}
      onToggle={() => setExpanded((id) => (id === finding.id ? null : finding.id))}
      onOverride={overridable ? (status) => void override(finding, status) : undefined}
      onDelete={canDeleteFinding(task, finding) ? () => void remove(finding) : undefined}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
        <div className="flex gap-1" role="group" aria-label="Filter by severity">
          {SEVERITIES.map((severity) => (
            <button
              key={severity}
              type="button"
              aria-pressed={severities.has(severity)}
              onClick={() => toggleSeverity(severity)}
              className={cn(
                "cursor-pointer rounded-sm bg-transparent focus-visible:shadow-ring",
                severities.size > 0 && !severities.has(severity) && "opacity-45",
              )}
            >
              <SeverityChip severity={severity}>
                {SEVERITY_LABELS[severity]} {counts[severity]}
              </SeverityChip>
            </button>
          ))}
        </div>
        <span className="h-[18px] w-px bg-border-strong" aria-hidden="true" />
        <label className="ml-1 inline-flex items-center gap-1.5 text-meta text-muted-foreground">
          <input
            type="checkbox"
            checked={gatingOnly}
            onChange={(event) => setGatingOnly(event.target.checked)}
          />
          Gating only
        </label>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
          <LockIcon size="sm" className="text-magenta" />
          Critical + High gate the loop
        </span>
      </div>
      {error && (
        <div className="px-5 pt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div role="table" aria-label="Review findings" className="min-h-0 flex-1 overflow-auto">
        <div
          role="row"
          className={cn(FINDING_GRID, "h-8 border-b border-border text-label text-faint uppercase")}
        >
          <span role="columnheader" />
          <span role="columnheader">Severity</span>
          <span role="columnheader">Finding</span>
          <span role="columnheader">Reviewer</span>
          <span role="columnheader">Location</span>
          <span role="columnheader" className="text-right">
            Triage
          </span>
        </div>
        {active.map(row)}
        {active.length === 0 && <p className={panelNote}>No open findings match the filter.</p>}
        {fixed.length > 0 && (
          <>
            <button
              type="button"
              aria-expanded={showFixed}
              onClick={() => setShowFixed((v) => !v)}
              className="flex cursor-pointer items-center gap-2 bg-transparent px-5 py-2.5 text-meta text-muted-foreground"
            >
              <ChevronRightIcon size="sm" className={cn(showFixed && "rotate-90")} />
              {fixed.length} {fixed.length === 1 ? "finding" : "findings"} fixed in earlier rounds
            </button>
            {showFixed && fixed.map(row)}
          </>
        )}
      </div>
    </div>
  );
}
