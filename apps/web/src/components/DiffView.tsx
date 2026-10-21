import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/utils";
import type { DiffLine } from "../task-view";

const LINE_TONES: Record<DiffLine["kind"], string> = {
  hunk: "bg-muted text-muted-foreground",
  add: "bg-diff-add text-diff-add-fg",
  del: "bg-diff-del text-diff-del-fg",
  ctx: "text-foreground",
};

const SIGNS: Record<DiffLine["kind"], string> = { hunk: "", add: "+", del: "-", ctx: " " };

/**
 * Unified diff lines (`.dl`): plain green and red, never neon. `annotations`
 * are shown under the line at their index, as wide as the visible box, so
 * they stay in view while the lines scroll sideways.
 */
export function DiffView({
  lines,
  annotations,
  className,
}: {
  lines: readonly DiffLine[];
  annotations?: ReadonlyMap<number, ReactNode>;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "bw-chamfer-box @container overflow-x-auto bg-code font-mono text-code [--bw-chamfer-line:var(--border)]",
        className,
      )}
    >
      <div className="min-w-max">
        {lines.map((line, i) => {
          const annotation = annotations?.get(i);
          return (
            <Fragment key={i}>
              <div
                className={cn(
                  "grid grid-cols-[48px_16px_minmax(0,1fr)] whitespace-pre",
                  LINE_TONES[line.kind],
                )}
              >
                <span className="pr-2 text-right text-faint select-none">{line.line ?? ""}</span>
                <span className="select-none">{SIGNS[line.kind]}</span>
                <span className="pr-3">{line.text}</span>
              </div>
              {annotation !== undefined && (
                <div className="sticky left-0 w-[100cqw] px-3 py-2 font-sans text-body whitespace-normal">
                  {annotation}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
