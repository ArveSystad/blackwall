import type { ConnectionView, OriginKind, PrMode } from "@blackwall/shared";
import { IssueIcon, JiraIcon, PullRequestIcon, TextIcon } from "./icons";

/** The origins a task or backlog item can start from, in their 1 / 2 / 3 / 4 order. */
export const ORIGINS: { value: OriginKind; label: string; icon: typeof JiraIcon }[] = [
  { value: "jira-issue", label: "Jira issue", icon: JiraIcon },
  { value: "github-pr", label: "GitHub PR", icon: PullRequestIcon },
  { value: "free-text", label: "Blackwall", icon: TextIcon },
  { value: "github-issue", label: "GitHub issue", icon: IssueIcon },
];

/** The origins backed by a connection with a token, in `ORIGINS` order; all of them while unknown. */
export function availableOrigins(
  connections: readonly Pick<ConnectionView, "kind" | "hasToken">[] | undefined,
): typeof ORIGINS {
  if (!connections) return ORIGINS;
  const has = (kind: ConnectionView["kind"]) =>
    connections.some((c) => c.kind === kind && c.hasToken);
  return ORIGINS.filter(({ value }) =>
    value === "jira-issue"
      ? has("jira")
      : value === "github-pr" || value === "github-issue"
        ? has("github")
        : true,
  );
}

export const ORIGIN_ICONS = Object.fromEntries(
  ORIGINS.map(({ value, icon }) => [value, icon]),
) as Record<OriginKind, typeof JiraIcon>;

export const PR_MODE_LABELS: Record<PrMode, string> = { work: "Work on PR", review: "Review PR" };
