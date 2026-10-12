import type { AssignedIssue, BacklogItemView, Task } from "@blackwall/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MissingCredentialError, createBacklogItem } from "../api";
import { issueOrigin, issueWork, type IssueWork } from "../assigned-issues";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { IssueRow, IssueWorkLink } from "../components/IssueRow";
import { Section } from "../components/Section";
import { Button } from "../components/ui/button";
import { ErrorText } from "../components/ui/field";
import { useWithCredential } from "../credentials";
import { useNow } from "../hooks";
import { originKey } from "../inbox";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import {
  assignedIssuesQuery,
  backlogQuery,
  issuesRefreshSeconds,
  queryKeys,
  settingsQuery,
  taskQuery,
  tasksQuery,
} from "../query";
import { groupByHost } from "../review-requests";
import { errorMessage } from "../settings-forms";

/**
 * Adds the issue with defaults to its repo's backlog; the server starts it at
 * once when that backlog runs. The row then links to what was created.
 */
function WorkOnTask({ issue, repoId }: { issue: AssignedIssue; repoId: string }) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function work() {
    if (pending) return;
    setPending(true);
    setError(null);
    const origin = issueOrigin(issue);
    try {
      const created = await withCredential(
        { label: "Work on task", target: originKey({ origin }) },
        () => createBacklogItem(repoId, { origin, start: true }),
      );
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
      if (created.taskId) {
        const task = await queryClient.fetchQuery(taskQuery(created.taskId));
        queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
          tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
        );
      }
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void work()}>
        Work on task
      </Button>
      {error && <ErrorText className="max-w-60 text-right">{error}</ErrorText>}
    </span>
  );
}

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
  return <WorkOnTask issue={issue} repoId={issue.repoId} />;
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
