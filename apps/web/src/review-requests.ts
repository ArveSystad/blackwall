import type {
  BacklogItem,
  ConnectionView,
  ReviewRequest,
  Task,
  TaskOrigin,
} from "@blackwall/shared";
import { githubWork, type IssueWork } from "./assigned-issues";
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

/** Rows per host, hosts by name; each host keeps the server's newest-first order. */
export function groupByHost<T extends { host: string }>(
  rows: readonly T[],
): { host: string; rows: T[] }[] {
  const byHost = new Map<string, T[]>();
  for (const row of rows) {
    const list = byHost.get(row.host);
    if (list) list.push(row);
    else byHost.set(row.host, [row]);
  }
  return [...byHost]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, list]) => ({ host, rows: list }));
}

/** The home pill's full label, also its accessible name. */
export function reviewPillLabel(count: number): string {
  if (count === 0) return "No pull requests need your review";
  return `${plural(count, "pull request")} ${count === 1 ? "needs" : "need"} your review`;
}

/** The `github-pr` task origin for a PR waiting on the user's review. */
export function prOrigin(
  pr: Pick<ReviewRequest, "url" | "owner" | "repo" | "number" | "connectionId">,
): Extract<TaskOrigin, { kind: "github-pr" }> {
  return {
    kind: "github-pr",
    url: pr.url,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    connectionId: pr.connectionId,
  };
}

/**
 * The task or backlog item already working on `pr`, in either PR mode, so its
 * row links there instead of adding a duplicate; see {@link githubWork}.
 */
export function pullRequestWork(
  pr: Pick<ReviewRequest, "host" | "owner" | "repo" | "number">,
  tasks: readonly Pick<Task, "id" | "origin" | "archivedAt">[],
  backlogItems: readonly Pick<BacklogItem, "repoId" | "origin" | "status" | "taskId">[],
): IssueWork {
  return githubWork("github-pr", pr, tasks, backlogItems);
}

/** Whether any GitHub/GHE connection has a token to search with. */
export function hasGitHubConnection(connections: readonly ConnectionView[]): boolean {
  return connections.some((c) => c.kind === "github" && c.hasToken);
}
