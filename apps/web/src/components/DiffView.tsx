import { cn } from "../lib/utils";
import type { DiffLine } from "../task-view";

const LINE_TONES: Record<DiffLine["kind"], string> = {
  hunk: "bg-muted text-muted-foreground",
  add: "bg-diff-add text-diff-add-fg",
  del: "bg-diff-del text-diff-del-fg",
  ctx: "text-foreground",
};

const SIGNS: Record<DiffLine["kind"], string> = { hunk: "", add: "+", del: "-", ctx: " " };

/** Unified diff lines (`.dl`): plain green and red, never neon. */
export function DiffView({ lines, className }: { lines: readonly DiffLine[]; className?: string }) {
  return (
    <div
      className={cn(
        "bw-chamfer-box overflow-x-auto bg-code font-mono text-code [--bw-chamfer-line:var(--border)]",
        className,
      )}
    >
      <div className="min-w-max">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[48px_16px_minmax(0,1fr)] whitespace-pre",
              LINE_TONES[line.kind],
            )}
          >
            <span className="pr-2 text-right text-faint select-none">{line.line ?? ""}</span>
            <span className="select-none">{SIGNS[line.kind]}</span>
            <span className="pr-3">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
