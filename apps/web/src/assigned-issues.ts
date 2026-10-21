import type {
  AssignedIssue,
  BacklogItem,
  RepoJiraIssue,
  Task,
  TaskOrigin,
} from "@blackwall/shared";
import { plural } from "./backlog";

/** The home pill's full label, also its accessible name. */
export function issuePillLabel(count: number): string {
  if (count === 0) return "No issues assigned to you";
  return `${plural(count, "issue")} assigned to you`;
}

/** What already works on an assigned issue: a task, a backlog item in its repo, or nothing. */
export type IssueWork =
  { kind: "task"; taskId: string } | { kind: "backlog"; repoId: string } | null;

/** The `github-issue` task origin for an assigned issue. */
export function issueOrigin(
  issue: Pick<AssignedIssue, "url" | "owner" | "repo" | "number" | "connectionId">,
): Extract<TaskOrigin, { kind: "github-issue" }> {
  return {
    kind: "github-issue",
    url: issue.url,
    owner: issue.owner,
    repo: issue.repo,
    number: issue.number,
    connectionId: issue.connectionId,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** A GitHub issue or PR as the lists show it. */
type GitHubItem = Pick<AssignedIssue, "host" | "owner" | "repo" | "number">;

/** Same origin kind, host, owner, repo (case-insensitive) and number. */
export function sameGitHubItem(
  origin: TaskOrigin,
  kind: "github-issue" | "github-pr",
  item: GitHubItem,
): boolean {
  return (
    origin.kind === kind &&
    origin.number === item.number &&
    origin.owner.toLowerCase() === item.owner.toLowerCase() &&
    origin.repo.toLowerCase() === item.repo.toLowerCase() &&
    hostOf(origin.url) === item.host.toLowerCase()
  );
}

/**
 * The task or backlog item already working on the GitHub `item` of `kind`, so
 * its row links there instead of adding a duplicate. Archived tasks don't
 * count; a promoted backlog item counts as its task.
 */
export function githubWork(
  kind: "github-issue" | "github-pr",
  item: GitHubItem,
  tasks: readonly Pick<Task, "id" | "origin" | "archivedAt">[],
  backlogItems: readonly Pick<BacklogItem, "repoId" | "origin" | "status" | "taskId">[],
): IssueWork {
  const archived = new Set(tasks.filter((t) => t.archivedAt !== null).map((t) => t.id));
  const task = tasks.find((t) => t.archivedAt === null && sameGitHubItem(t.origin, kind, item));
  if (task) return { kind: "task", taskId: task.id };
  for (const backlogItem of backlogItems) {
    if (!sameGitHubItem(backlogItem.origin, kind, item)) continue;
    if (backlogItem.status !== "promoted") return { kind: "backlog", repoId: backlogItem.repoId };
    if (backlogItem.taskId && !archived.has(backlogItem.taskId))
      return { kind: "task", taskId: backlogItem.taskId };
  }
  return null;
}

/** The task or backlog item already working on `issue`; see {@link githubWork}. */
export function issueWork(
  issue: GitHubItem,
  tasks: readonly Pick<Task, "id" | "origin" | "archivedAt">[],
  backlogItems: readonly Pick<BacklogItem, "repoId" | "origin" | "status" | "taskId">[],
): IssueWork {
  return githubWork("github-issue", issue, tasks, backlogItems);
}

/** The `jira-issue` task origin for a listed Jira issue. */
export function jiraIssueOrigin(
  issue: Pick<RepoJiraIssue, "key" | "connectionId">,
): Extract<TaskOrigin, { kind: "jira-issue" }> {
  return { kind: "jira-issue", key: issue.key, connectionId: issue.connectionId };
}

/** Same Jira key, on the same connection or one left to the only Jira site. */
function sameJiraIssue(
  origin: TaskOrigin,
  issue: Pick<RepoJiraIssue, "key" | "connectionId">,
): boolean {
  return (
    origin.kind === "jira-issue" &&
    origin.key === issue.key &&
    (origin.connectionId === null || origin.connectionId === issue.connectionId)
  );
}

/**
 * The task or backlog item already working on the Jira `issue`, with the
 * rules of {@link githubWork}.
 */
export function jiraIssueWork(
  issue: Pick<RepoJiraIssue, "key" | "connectionId">,
  tasks: readonly Pick<Task, "id" | "origin" | "archivedAt">[],
  backlogItems: readonly Pick<BacklogItem, "repoId" | "origin" | "status" | "taskId">[],
): IssueWork {
  const archived = new Set(tasks.filter((t) => t.archivedAt !== null).map((t) => t.id));
  const task = tasks.find((t) => t.archivedAt === null && sameJiraIssue(t.origin, issue));
  if (task) return { kind: "task", taskId: task.id };
  for (const backlogItem of backlogItems) {
    if (!sameJiraIssue(backlogItem.origin, issue)) continue;
    if (backlogItem.status !== "promoted") return { kind: "backlog", repoId: backlogItem.repoId };
    if (backlogItem.taskId && !archived.has(backlogItem.taskId))
      return { kind: "task", taskId: backlogItem.taskId };
  }
  return null;
}
