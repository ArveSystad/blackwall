import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  forgetUnlisted,
  hasUnseenActivity,
  myPrPillLabel,
  useSeenPullRequests,
} from "../my-pull-requests";
import { connectionsQuery, myPullRequestsQuery } from "../query";
import { hasGitHubConnection } from "../review-requests";
import { CountPill } from "./CountPill";

/**
 * The home grid's pill counting the open PRs the user wrote across every
 * GitHub host. While any are open, the whole pill glows magenta; while one
 * has news the user hasn't opened, a steady yellow halo surrounds it. Opens
 * the My pull requests list. Hidden without a GitHub token.
 */
export function MyPullRequestsPill() {
  const connections = useQuery(connectionsQuery);
  const enabled = hasGitHubConnection(connections.data ?? []);
  const pulls = useQuery({ ...myPullRequestsQuery, enabled });
  const seen = useSeenPullRequests();
  const data = pulls.data;
  useEffect(() => {
    // A failing host's PRs are missing from the list; keep what was seen of them.
    if (data && data.errors.length === 0) forgetUnlisted(data.pullRequests.map((pr) => pr.url));
  }, [data]);
  if (!enabled) return null;

  return (
    <CountPill
      to="/pulls"
      query={pulls}
      count={(rows) => rows.pullRequests.length}
      label={myPrPillLabel}
      unit={(count) => (count === 1 ? "pull request open" : "pull requests open")}
      loadingLabel="Checking your pull requests…"
      errorLabel="Could not load your pull requests"
      activity={data?.pullRequests.some((pr) => hasUnseenActivity(pr, seen)) ?? false}
    />
  );
}
