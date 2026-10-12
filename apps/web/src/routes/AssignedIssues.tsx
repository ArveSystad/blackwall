import type { AssignedIssue, BacklogItemView, Task } from "@blackwall/shared";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MissingCredentialError, createBacklogItem } from "../api";
import { issueOrigin, issueWork, type IssueWork } from "../assigned-issues";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { ORIGIN_ICONS } from "../components/origins";
import { Section } from "../components/Section";
import { Button } from "../components/ui/button";
import { ErrorText } from "../components/ui/field";
import { useWithCredential } from "../credentials";
import { useNow } from "../hooks";
import { originKey, relativeTime } from "../inbox";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import { assignedIssuesQuery, backlogQuery, queryKeys, taskQuery, tasksQuery } from "../query";
import { groupByHost } from "../review-requests";
import { errorMessage } from "../settings-forms";

const IssueIcon = ORIGIN_ICONS["github-issue"];

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
  if (work?.kind === "task")
    return (
      <Link
        to="/tasks/$taskId"
        params={{ taskId: work.taskId }}
        className="text-body whitespace-nowrap"
      >
        Open task
      </Link>
    );
  if (work?.kind === "backlog")
    return (
      <Link
        to="/repos/$repoId/backlog"
        params={{ repoId: work.repoId }}
        className="text-body whitespace-nowrap"
      >
        In backlog
      </Link>
    );
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

/** One open issue assigned to the user; the row opens it on GitHub, except for its trailing action. */
function IssueRow({ issue, work, now }: { issue: AssignedIssue; work: IssueWork; now: Date }) {
  return (
    <li className="flex items-center gap-1 rounded-lg hover:bg-card">
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
      <span className="flex flex-none items-center pr-2">
        <IssueAction issue={issue} work={work} />
      </span>
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
                        work={issueWork(issue, tasks.data ?? [], backlogItems)}
                        now={now}
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
