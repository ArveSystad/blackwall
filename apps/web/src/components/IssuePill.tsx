import { useQuery } from "@tanstack/react-query";
import { issuePillLabel } from "../assigned-issues";
import {
  assignedIssuesQuery,
  connectionsQuery,
  issuesRefreshSeconds,
  settingsQuery,
} from "../query";
import { hasGitHubConnection } from "../review-requests";
import { CountPill } from "./CountPill";

/**
 * The home grid's pill counting the open issues assigned to the user across
 * every GitHub host, magenta while any are. Opens the assigned issues list.
 * Hidden without a GitHub token.
 */
export function IssuePill() {
  const connections = useQuery(connectionsQuery);
  const enabled = hasGitHubConnection(connections.data ?? []);
  const settings = useQuery(settingsQuery);
  const issues = useQuery({
    ...assignedIssuesQuery(issuesRefreshSeconds(settings.data)),
    enabled,
  });
  if (!enabled) return null;

  return (
    <CountPill
      to="/issues"
      query={issues}
      count={(data) => data.issues.length}
      label={issuePillLabel}
      unit={(count) => (count === 1 ? "issue assigned to you" : "issues assigned to you")}
      loadingLabel="Checking issues…"
      errorLabel="Could not load issues"
    />
  );
}
