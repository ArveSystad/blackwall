import type { AssignedIssue, BacklogItemView } from "@blackwall/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { issueOrigin, issueWork, type IssueWork } from "../assigned-issues";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { IssueRow, IssueWorkLink } from "../components/IssueRow";
import { RefreshButton } from "../components/RefreshButton";
import { Section } from "../components/Section";
import { Button } from "../components/ui/button";
import { WorkOnTask } from "../components/WorkOnTask";
import { useNow } from "../hooks";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import {
  assignedIssuesQuery,
  backlogQuery,
  issuesRefreshSeconds,
  settingsQuery,
  tasksQuery,
} from "../query";
import { groupByHost } from "../review-requests";

/** The row's trailing action: a link to the work on the issue, else "Work on task". */
function IssueAction({ issue, work }: { issue: AssignedIssue; work: IssueWork }) {
  if (work) return <IssueWorkLink work={work} />;
  if (issue.repoId === null)
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled
        title={`Register ${issue.owner}/${issue.repo} to work on it`}
      >
        Work on task
      </Button>
    );
  return <WorkOnTask origin={issueOrigin(issue)} mode={null} repoId={issue.repoId} />;
}

/**
 * Open issues assigned to the user across every GitHub host, grouped by host.
 * Polled at the GitHub issues refresh interval, since GitHub sends no live events.
 */
export function AssignedIssues() {
  const navigate = useNavigate();
  const settings = useQuery(settingsQuery);
  const issues = useQuery(assignedIssuesQuery(issuesRefreshSeconds(settings.data)));
  const now = useNow();
  const groups = useMemo(() => groupByHost(issues.data?.issues ?? []), [issues.data?.issues]);
  const tasks = useQuery(tasksQuery);
  const repoIds = useMemo(
    () => [...new Set((issues.data?.issues ?? []).flatMap((issue) => issue.repoId ?? []))],
    [issues.data?.issues],
  );
  const backlogs = useQueries({ queries: repoIds.map((repoId) => backlogQuery(repoId)) });
  const backlogItems: BacklogItemView[] = backlogs.flatMap((backlog) => backlog.data ?? []);

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={cn(paneHeader, "bg-sidebar")}>
        <h1 className={paneTitle}>Assigned issues</h1>
        {issues.data && (
          <span className="mono text-label text-faint">{issues.data.issues.length} open</span>
        )}
        <span className="flex-1" />
        <RefreshButton fetching={issues.isFetching} onRefresh={() => void issues.refetch()} />
      </div>

      <div className={paneBody}>
        {issues.isPending ? (
          <EmptyState key="loading" role="status" title="Fetching assigned issues…" />
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
                  <EmptyState key="empty" title="All clear. No issues assigned to you.">
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
                      <IssueRow
                        key={issue.url}
                        issue={issue}
                        now={now}
                        action={
                          <IssueAction
                            issue={issue}
                            work={issueWork(issue, tasks.data ?? [], backlogItems)}
                          />
                        }
                      />
                    ))}
                  </Section>
                ))}
          </>
        )}
      </div>
    </div>
  );
}
