import type { AssignedIssue } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { ORIGIN_ICONS } from "../components/origins";
import { Section } from "../components/Section";
import { Button } from "../components/ui/button";
import { useNow } from "../hooks";
import { relativeTime } from "../inbox";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import { assignedIssuesQuery } from "../query";
import { groupByHost } from "../review-requests";

const IssueIcon = ORIGIN_ICONS["github-issue"];

/** One open issue assigned to the user; the row opens it on GitHub. */
function IssueRow({ issue, now }: { issue: AssignedIssue; now: Date }) {
  return (
    <li className="flex items-center rounded-lg hover:bg-card">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-transparent py-1.5 pr-2 pl-1.5 text-foreground no-underline hover:no-underline focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none"
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
          </span>
        </span>
      </a>
    </li>
  );
}

/**
 * Open issues assigned to the user across every GitHub host, grouped by host.
 * Polled, since GitHub sends no live events.
 */
export function AssignedIssues() {
  const navigate = useNavigate();
  const issues = useQuery(assignedIssuesQuery);
  const now = useNow();
  const groups = useMemo(() => groupByHost(issues.data?.issues ?? []), [issues.data?.issues]);

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={cn(paneHeader, "bg-sidebar")}>
        <h1 className={paneTitle}>Assigned issues</h1>
        {issues.data && (
          <span className="mono text-label text-faint">{issues.data.issues.length} open</span>
        )}
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={issues.isFetching}
          onClick={() => void issues.refetch()}
        >
          Refresh
        </Button>
      </div>

      <div className={paneBody}>
        {issues.isPending ? (
          <EmptyState key="loading" role="status" title="Loading issues…" />
        ) : issues.isError ? (
          <EmptyState
            key="error"
            role="alert"
            title="Could not load issues"
            onRetry={() => void issues.refetch()}
          >
            {issues.error.message}
          </EmptyState>
        ) : (
          <>
            {issues.data.errors.map((error) => (
              <EmptyState
                key={`error:${error.host}`}
                role="alert"
                title={`Could not load issues from ${error.host}`}
                className="flex-none"
                onRetry={() => void issues.refetch()}
              >
                {error.message}
              </EmptyState>
            ))}
            {groups.length === 0
              ? issues.data.errors.length === 0 && (
                  <EmptyState key="empty" title="No issues assigned to you">
                    Open issues assigned to you on every GitHub host.
                  </EmptyState>
                )
              : groups.map((group) => (
                  <Section
                    key={group.host}
                    label={group.host}
                    ariaLabel={group.host}
                    count={group.rows.length}
                  >
                    {group.rows.map((issue) => (
                      <IssueRow key={issue.url} issue={issue} now={now} />
                    ))}
                  </Section>
                ))}
          </>
        )}
      </div>
    </div>
  );
}
