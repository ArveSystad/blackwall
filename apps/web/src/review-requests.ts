import type { ConnectionView, ReviewRequest } from "@blackwall/shared";
import { plural } from "./backlog";

type ReviewDecision = ReviewRequest["reviewDecision"];

/** What a PR waiting on the user's review still needs, by GitHub's review decision. */
export const REVIEW_STATUS_LABELS: Record<NonNullable<ReviewDecision>, string> = {
  "review-required": "Review required",
  "changes-requested": "Changes requested",
};

/** The status pill's label; a repo without required reviews has no decision. */
export function reviewStatusLabel(decision: ReviewDecision): string {
  return decision ? REVIEW_STATUS_LABELS[decision] : "Awaiting review";
}

/** PRs per host, hosts by name; each host keeps the server's newest-first order. */
export function groupByHost(
  pullRequests: readonly ReviewRequest[],
): { host: string; pullRequests: ReviewRequest[] }[] {
  const byHost = new Map<string, ReviewRequest[]>();
  for (const pr of pullRequests) {
    const list = byHost.get(pr.host);
    if (list) list.push(pr);
    else byHost.set(pr.host, [pr]);
  }
  return [...byHost]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, list]) => ({ host, pullRequests: list }));
}

/** The home pill's full label, also its accessible name. */
export function reviewPillLabel(count: number): string {
  if (count === 0) return "No pull requests need your review";
  return `${plural(count, "pull request")} ${count === 1 ? "needs" : "need"} your review`;
}

/** Whether any GitHub/GHE connection has a token to search with. */
export function hasGitHubConnection(connections: readonly ConnectionView[]): boolean {
  return connections.some((c) => c.kind === "github" && c.hasToken);
}
