import type { AssignedIssue, RepoJiraIssue } from "@blackwall/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { IssueWork } from "../assigned-issues";
import { relativeTime } from "../inbox";
import { ORIGIN_ICONS } from "./origins";

const IssueIcon = ORIGIN_ICONS["github-issue"];
const JiraIcon = ORIGIN_ICONS["jira-issue"];

/** A link to the task or backlog already working on an issue. */
export function IssueWorkLink({ work }: { work: NonNullable<IssueWork> }) {
  return work.kind === "task" ? (
    <Link
      to="/tasks/$taskId"
      params={{ taskId: work.taskId }}
      className="text-body whitespace-nowrap"
    >
      Open task
    </Link>
  ) : (
    <Link
      to="/repos/$repoId/backlog"
      params={{ repoId: work.repoId }}
      className="text-body whitespace-nowrap"
    >
      In backlog
    </Link>
  );
}

/**
 * One open GitHub issue; the row opens it on GitHub, except for its trailing
 * `action`. With `assignees`, the meta line lists them ("Unassigned" when empty).
 */
export function IssueRow({
  issue,
  now,
  action,
  assignees,
}: {
  issue: AssignedIssue;
  now: Date;
  action: ReactNode;
  assignees?: readonly string[];
}) {
  return (
    <li className="bw-chamfer flex items-center gap-1 [--bw-chamfer-line:transparent] hover:bg-card">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="bw-chamfer bw-chamfer-focus flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2 pl-1.5 text-foreground no-underline [--bw-chamfer-line:transparent] hover:no-underline focus-visible:outline-none"
      >
        <IssueIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground-strong">{issue.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">
              {issue.owner}/{issue.repo}#{issue.number}
            </span>
            {issue.author && <span className="mono truncate">{issue.author}</span>}
            <time className="whitespace-nowrap" dateTime={issue.updatedAt.toISOString()}>
              {relativeTime(issue.updatedAt, now)}
            </time>
            {assignees && (
              <span className="truncate">
                {assignees.length > 0 ? `Assigned to ${assignees.join(", ")}` : "Unassigned"}
              </span>
            )}
          </span>
        </span>
      </a>
      <span className="flex flex-none items-center pr-2">{action}</span>
    </li>
  );
}

/** One open Jira issue; the row opens it in Jira, except for its trailing `action`. */
export function JiraIssueRow({
  issue,
  now,
  action,
}: {
  issue: RepoJiraIssue;
  now: Date;
  action: ReactNode;
}) {
  return (
    <li className="bw-chamfer flex items-center gap-1 [--bw-chamfer-line:transparent] hover:bg-card">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="bw-chamfer bw-chamfer-focus flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2 pl-1.5 text-foreground no-underline [--bw-chamfer-line:transparent] hover:no-underline focus-visible:outline-none"
      >
        <JiraIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground-strong">{issue.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">{issue.key}</span>
            {issue.issueType && <span className="truncate">{issue.issueType}</span>}
            {issue.status && <span className="truncate">{issue.status}</span>}
            {issue.author && <span className="truncate">{issue.author}</span>}
            <time className="whitespace-nowrap" dateTime={issue.updatedAt.toISOString()}>
              {relativeTime(issue.updatedAt, now)}
            </time>
            <span className="truncate">
              {issue.assignee ? `Assigned to ${issue.assignee}` : "Unassigned"}
            </span>
          </span>
        </span>
      </a>
      <span className="flex flex-none items-center pr-2">{action}</span>
    </li>
  );
}
