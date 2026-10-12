import { useQuery } from "@tanstack/react-query";
import { connectionsQuery, reviewRequestsQuery } from "../query";
import { hasGitHubConnection, reviewPillLabel } from "../review-requests";
import { CountPill } from "./CountPill";

/**
 * The home grid's pill counting the open PRs waiting on the user's review
 * across every GitHub host. While any do, the whole pill glows magenta. Opens
 * the review requests list. Hidden without a GitHub token.
 */
export function ReviewPill() {
  const connections = useQuery(connectionsQuery);
  const enabled = hasGitHubConnection(connections.data ?? []);
  const reviews = useQuery({ ...reviewRequestsQuery, enabled });
  if (!enabled) return null;

  return (
    <CountPill
      to="/reviews"
      query={reviews}
      count={(data) => data.pullRequests.length}
      label={reviewPillLabel}
      unit={(count) =>
        count === 1 ? "pull request needs your review" : "pull requests need your review"
      }
      loadingLabel="Checking pull requests…"
      errorLabel="Could not load pull requests"
    />
  );
}
