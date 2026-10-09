import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { WallIcon } from "./icons";
import { Button } from "./ui/button";

/**
 * A centered message filling its pane: loading, empty, not found or a load error.
 *
 * Pass `role="alert"` for load errors and `role="status"` for loading; plain empty states get no
 * role. Where several states share one position, give each a distinct `key` so React inserts the
 * alert as a new node and screen readers announce it. A `status` region whose text is there on
 * mount is not reliably announced; it is there for semantics only.
 */
export function EmptyState({
  title,
  children,
  onRetry,
  role,
  className,
}: {
  title: string;
  children?: ReactNode;
  onRetry?: () => void;
  role?: "status" | "alert";
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center",
        className,
      )}
    >
      <WallIcon className="size-7 text-faint" />
      <div className="font-medium text-foreground-strong">{title}</div>
      {(children || onRetry) && (
        <div className="max-w-80 text-meta text-muted-foreground">
          {children}
          {onRetry && (
            <>
              {" "}
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Retry
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
