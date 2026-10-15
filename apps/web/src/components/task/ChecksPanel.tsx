import type { Step } from "@blackwall/shared";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { checkPassed, type CheckRun } from "../../task-view";
import { panelNote } from "../classes";
import { CheckIcon, ChevronRightIcon, FailedIcon } from "../icons";
import { ErrorText } from "../ui/field";

function CheckRow({ check }: { check: CheckRun }) {
  const passed = checkPassed(check);
  const [open, setOpen] = useState(!passed && !check.running);
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-md border border-border bg-card",
        check.running && "border-cyan/50 shadow-glow-cyan",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 min-w-0 cursor-pointer items-center gap-2 bg-transparent px-3 text-left"
      >
        <ChevronRightIcon size="sm" className={cn("text-muted-foreground", open && "rotate-90")} />
        <span className="mono min-w-0 flex-1 truncate text-foreground-strong">{check.command}</span>
        {check.running ? (
          <span className="mono text-[11px] text-cyan">running…</span>
        ) : passed ? (
          <span className="inline-flex items-center gap-1 text-meta text-done">
            <CheckIcon size="sm" />
            Passed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-meta text-failed">
            <FailedIcon size="sm" />
            {check.timedOut ? "Timed out" : `Exit ${check.exitCode ?? "?"}`}
          </span>
        )}
      </button>
      {open && (
        <pre className="m-0 max-h-96 overflow-auto border-t border-border bg-code px-3 py-2 font-mono text-code whitespace-pre-wrap text-foreground">
          {check.output.trim() || "(no output)"}
        </pre>
      )}
    </div>
  );
}

/** The repo's check commands from the latest Checks step, with their output. */
export function ChecksPanel({
  step,
  checks,
  loading,
}: {
  step: Step | undefined;
  checks: readonly CheckRun[];
  loading: boolean;
}) {
  if (!step) {
    return <p className={panelNote}>Standing by. Checks run after each implementation round.</p>;
  }
  if (loading) return <p className={panelNote}>Reading check results…</p>;
  const passed = checks.filter(checkPassed).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-5 py-4">
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="label">Round {step.round}</span>
        {checks.length > 0 && (
          <span>
            {passed}/{checks.length} passed
          </span>
        )}
      </div>
      {checks.length === 0 ? (
        <p className="m-0 text-muted-foreground">
          {step.status === "running"
            ? "Check commands spinning up."
            : "No check commands are configured for this repo, so Checks were skipped. Add them in Settings → Repositories."}
        </p>
      ) : (
        checks.map((check, i) => <CheckRow key={`${check.command}:${i}`} check={check} />)
      )}
      {step.error && <ErrorText>{step.error}</ErrorText>}
    </div>
  );
}
