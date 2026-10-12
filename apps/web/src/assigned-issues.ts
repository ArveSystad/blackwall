import type { AssignedIssue, BacklogItem, Task, TaskOrigin } from "@blackwall/shared";
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

/** Same host, owner, repo (case-insensitive) and number. */
function isIssue(origin: TaskOrigin, issue: AssignedIssue): boolean {
  return (
    origin.kind === "github-issue" &&
    origin.number === issue.number &&
    origin.owner.toLowerCase() === issue.owner.toLowerCase() &&
    origin.repo.toLowerCase() === issue.repo.toLowerCase() &&
    hostOf(origin.url) === issue.host.toLowerCase()
  );
}

/**
 * The task or backlog item already working on `issue`, so its row links there
 * instead of adding a duplicate. Archived tasks don't count; a promoted backlog
 * item counts as its task.
 */
export function issueWork(
  issue: AssignedIssue,
  tasks: readonly Pick<Task, "id" | "origin" | "archivedAt">[],
  backlogItems: readonly Pick<BacklogItem, "repoId" | "origin" | "status" | "taskId">[],
): IssueWork {
  const archived = new Set(tasks.filter((t) => t.archivedAt !== null).map((t) => t.id));
  const task = tasks.find((t) => t.archivedAt === null && isIssue(t.origin, issue));
  if (task) return { kind: "task", taskId: task.id };
  for (const item of backlogItems) {
    if (!isIssue(item.origin, issue)) continue;
    if (item.status !== "promoted") return { kind: "backlog", repoId: item.repoId };
    if (item.taskId && !archived.has(item.taskId)) return { kind: "task", taskId: item.taskId };
  }
  return null;
}
