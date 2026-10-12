import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { connectionsQuery, reviewRequestsQuery } from "../query";
import { hasGitHubConnection, reviewPillLabel } from "../review-requests";

/**
 * The home grid's pill under the dots: how many open PRs wait on the user's
 * review across every GitHub host. While any do, the whole pill glows magenta
 * (with a blinking dot) and the count and label share the colour. Opens the review requests list. Hidden without a GitHub token.
 */
export function ReviewPill() {
  const connections = useQuery(connectionsQuery);
  const enabled = hasGitHubConnection(connections.data ?? []);
  const reviews = useQuery({ ...reviewRequestsQuery, enabled });
  if (!enabled) return null;

  const data = reviews.data;
  const count = data?.pullRequests.length ?? 0;
  const hostErrors = data?.errors ?? [];
  // A failed refetch keeps the last data; only no data, or every host failing, is an error.
  const failed = (reviews.isError && !data) || (!!data && count === 0 && hostErrors.length > 0);
  const errorTitle = reviews.error
    ? reviews.error.message
    : hostErrors.map((e) => e.message).join("\n");
  const label =
    !data && !failed
      ? "Checking pull requests…"
      : failed
        ? "Could not load pull requests"
        : reviewPillLabel(count);
  const needed = !failed && count > 0;

  return (
    <Link
      to="/reviews"
      aria-label={label}
      title={hostErrors.length > 0 || failed ? errorTitle : undefined}
      className={cn(
        "pointer-events-auto absolute bottom-4 left-1/2 z-20 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border bg-popover px-4 whitespace-nowrap no-underline hover:no-underline focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none",
        needed ? "border-magenta" : "border-border-strong",
        needed ? "shadow-glow-needs" : "shadow-pop",
        needed ? "text-needs text-shadow-glow-needs" : "text-muted-foreground",
      )}
    >
      {!data || failed ? (
        <span className="text-meta">{label}</span>
      ) : (
        <>
          {needed && (
            <span aria-hidden="true" className="size-2 animate-blink-needs rounded-full bg-needs" />
          )}
          <span className={cn("mono text-[18px] font-semibold", !needed && "text-faint")}>
            {count}
          </span>
          <span className="text-meta">
            {count === 1 ? "pull request needs your review" : "pull requests need your review"}
          </span>
        </>
      )}
    </Link>
  );
}
