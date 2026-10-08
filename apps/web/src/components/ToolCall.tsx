import { useState } from "react";
import { cn } from "../lib/utils";
import { CheckIcon, ChevronRightIcon, FailedIcon } from "./icons";

/** A collapsible agent tool call (`.tool`): verb, mono target, and its result when expanded. */
export function ToolCall({
  name,
  target,
  input,
  output,
  isError,
  live,
}: {
  name: string;
  target: string;
  input: unknown;
  /** Null while the call is still running. */
  output: string | null;
  isError: boolean;
  /** The step is still streaming, so an unfinished call is in progress. */
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const running = output === null && live;
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-md border border-border bg-card",
        running && "border-cyan/50 shadow-glow-cyan",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 bg-transparent px-2.5 text-left text-meta"
      >
        <ChevronRightIcon size="sm" className={cn("text-muted-foreground", open && "rotate-90")} />
        <span className="text-muted-foreground">{name}</span>
        <span className="mono min-w-0 flex-1 truncate text-foreground-strong">{target}</span>
        {running ? (
          <span className="mono text-[11px] text-cyan">running…</span>
        ) : output === null ? null : isError ? (
          <FailedIcon size="sm" className="text-failed" aria-label="Failed" role="img" />
        ) : (
          <CheckIcon size="sm" className="text-done" aria-label="Done" role="img" />
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border bg-code px-3 py-2 font-mono text-code">
          {input !== undefined && (
            <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          {output !== null && (
            <pre
              className={cn(
                "m-0 max-h-80 overflow-auto whitespace-pre-wrap",
                isError ? "text-failed" : "text-foreground",
              )}
            >
              {output || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
