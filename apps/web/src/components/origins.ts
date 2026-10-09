import type { OriginKind, PrMode } from "@blackwall/shared";
import { JiraIcon, PullRequestIcon, TextIcon } from "./icons";

/** The origins a task or backlog item can start from, in their 1 / 2 / 3 order. */
export const ORIGINS: { value: OriginKind; label: string; icon: typeof JiraIcon }[] = [
  { value: "jira-issue", label: "Jira issue", icon: JiraIcon },
  { value: "github-pr", label: "GitHub PR", icon: PullRequestIcon },
  { value: "free-text", label: "Free text", icon: TextIcon },
];

export const ORIGIN_ICONS = Object.fromEntries(
  ORIGINS.map(({ value, icon }) => [value, icon]),
) as Record<OriginKind, typeof JiraIcon>;

export const PR_MODE_LABELS: Record<PrMode, string> = { work: "Work on PR", review: "Review PR" };
