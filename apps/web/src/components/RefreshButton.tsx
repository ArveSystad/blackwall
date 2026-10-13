import { SpinnerIcon } from "./icons";
import { Button } from "./ui/button";

/** Refresh for a polled list; a cyan spinner sits beside it while any fetch runs, polls included. */
export function RefreshButton({
  fetching,
  onRefresh,
}: {
  fetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {fetching && (
        <SpinnerIcon
          size="md"
          className="animate-spin text-cyan"
          role="status"
          aria-hidden={false}
          aria-label="Refreshing"
        />
      )}
      <Button variant="ghost" size="sm" disabled={fetching} onClick={onRefresh}>
        Refresh
      </Button>
    </span>
  );
}
