import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { CheckIcon } from "./icons";

/**
 * One action at finish (`.card` with a checkbox): what it is, exactly where it
 * goes, and what it sends, verbatim. Optional actions are drawn dashed and
 * start unticked.
 */
export function OutboundAction({
  title,
  target,
  body,
  checked,
  onChange,
  optional = false,
  completed = false,
  disabled = false,
  children,
}: {
  title: ReactNode;
  target?: ReactNode;
  /** The text that is sent (a comment or PR body). */
  body?: string | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
  optional?: boolean;
  /** Already performed by an earlier, failed attempt; it is not repeated. */
  completed?: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card p-3 has-focus-visible:shadow-ring",
        optional && "border-dashed bg-transparent",
      )}
    >
      <label
        className={cn(
          "flex min-w-0 gap-2.5",
          disabled && !completed ? "opacity-60" : "cursor-pointer",
        )}
      >
        {completed ? (
          <CheckIcon className="mt-0.5 flex-none text-done" aria-label="Already done" role="img" />
        ) : (
          <input
            type="checkbox"
            className="mt-0.5 flex-none focus:outline-none"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange(event.target.checked)}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium text-foreground-strong">
            {title}
            {completed && (
              <span className="ml-2 text-meta font-normal text-done">Already done</span>
            )}
          </span>
          {target && (
            <span className="mono text-[11.5px] break-all text-muted-foreground">{target}</span>
          )}
          {optional && !completed && (
            <span className="text-meta text-muted-foreground">Optional, off by default</span>
          )}
        </span>
      </label>
      {body && (
        <pre className="m-0 ml-[25px] max-h-48 overflow-auto rounded-md border border-border bg-sidebar px-2.5 py-2 font-sans text-meta whitespace-pre-wrap text-foreground">
          {body}
        </pre>
      )}
      {children && <div className="ml-[25px]">{children}</div>}
    </div>
  );
}
