import type { BacklogItemView, ReviewRequest } from "@blackwall/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import type { IssueWork } from "../assigned-issues";
import { paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import { IssueWorkLink } from "../components/IssueRow";
import { ORIGIN_ICONS } from "../components/origins";
import { RefreshButton } from "../components/RefreshButton";
import { Section } from "../components/Section";
import { pill } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { WorkOnTask } from "../components/WorkOnTask";
import { useNow } from "../hooks";
import { relativeTime } from "../inbox";
import { useEscapeTo } from "../keyboard";
import { cn } from "../lib/utils";
import { backlogQuery, reviewRequestsQuery, tasksQuery } from "../query";
import { groupByHost, prOrigin, pullRequestWork, reviewStatusLabel } from "../review-requests";

const PullRequestIcon = ORIGIN_ICONS["github-pr"];

/** The row's trailing action: a link to the work on the PR, else "Work on task" as a review. */
function PullRequestAction({ pr, work }: { pr: ReviewRequest; work: IssueWork }) {
  if (work) return <IssueWorkLink work={work} />;
  if (pr.repoId === null)
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled
        title={`Register ${pr.owner}/${pr.repo} to work on it`}
      >
        Work on task
      </Button>
    );
  return (
    <WorkOnTask
      origin={prOrigin(pr)}
      mode="review"
      repoId={pr.repoId}
      title="Review this PR as a task"
    />
  );
}

/** One PR waiting on the user's review; the row opens it on GitHub, except for its trailing `action`. */
function ReviewRow({ pr, now, action }: { pr: ReviewRequest; now: Date; action: ReactNode }) {
  return (
    <li className="flex items-center gap-1 rounded-lg hover:bg-card">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg border border-transparent py-1.5 pr-2 pl-1.5 text-foreground no-underline hover:no-underline focus-visible:border-cyan focus-visible:shadow-ring focus-visible:outline-none"
      >
        <PullRequestIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-foreground-strong">{pr.title}</span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">
              {pr.owner}/{pr.repo}#{pr.number}
            </span>
            {pr.author && <span className="mono truncate">{pr.author}</span>}
            <time className="whitespace-nowrap" dateTime={pr.updatedAt.toISOString()}>
              {relativeTime(pr.updatedAt, now)}
            </time>
          </span>
        </span>
        <span className={cn(pill, "bg-muted-foreground/12 text-muted-foreground")}>
          {reviewStatusLabel(pr.reviewDecision)}
        </span>
      </a>
      <span className="flex flex-none items-center pr-2">{action}</span>
    </li>
  );
}

/**
 * Open pull requests waiting on the user's review across every GitHub host,
 * grouped by host. Polled, since GitHub sends no live events. "Work on task"
 * adds a PR to its registered repo's backlog as a Review PR task and starts it.
 */
export function ReviewRequests() {
  const navigate = useNavigate();
  const reviews = useQuery(reviewRequestsQuery);
  const now = useNow();
  const groups = useMemo(
    () => groupByHost(reviews.data?.pullRequests ?? []),
    [reviews.data?.pullRequests],
  );
  const tasks = useQuery(tasksQuery);
  const repoIds = useMemo(
    () => [...new Set((reviews.data?.pullRequests ?? []).flatMap((pr) => pr.repoId ?? []))],
    [reviews.data?.pullRequests],
  );
  const backlogs = useQueries({ queries: repoIds.map((repoId) => backlogQuery(repoId)) });
  const backlogItems: BacklogItemView[] = backlogs.flatMap((backlog) => backlog.data ?? []);

  useEscapeTo(() => void navigate({ to: "/" }));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className={cn(paneHeader, "bg-sidebar")}>
        <h1 className={paneTitle}>Review requests</h1>
        {reviews.data && (
          <span className="mono text-label text-faint">
            {reviews.data.pullRequests.length} waiting
          </span>
        )}
        <span className="flex-1" />
        <RefreshButton fetching={reviews.isFetching} onRefresh={() => void reviews.refetch()} />
      </div>

      <div className={paneBody}>
        {reviews.isPending ? (
          <EmptyState key="loading" role="status" title="Loading pull requests…" />
        ) : reviews.isError ? (
          <EmptyState
            key="error"
            role="alert"
            title="Could not load pull requests"
            onRetry={() => void reviews.refetch()}
          >
            {reviews.error.message}
          </EmptyState>
        ) : (
          <>
            {reviews.data.errors.map((error) => (
              <EmptyState
                key={`error:${error.host}`}
                role="alert"
                title={`Could not load pull requests from ${error.host}`}
                className="flex-none"
                onRetry={() => void reviews.refetch()}
              >
                {error.message}
              </EmptyState>
            ))}
            {groups.length === 0
              ? reviews.data.errors.length === 0 && (
                  <EmptyState key="empty" title="No pull requests need your review">
                    Open PRs where you or one of your teams is a requested reviewer, and nobody has
                    approved yet.
                  </EmptyState>
                )
              : groups.map((group) => (
                  <Section
                    key={group.host}
                    label={group.host}
                    ariaLabel={group.host}
                    count={group.rows.length}
                  >
                    {group.rows.map((pr) => (
                      <ReviewRow
                        key={pr.url}
                        pr={pr}
                        now={now}
                        action={
                          <PullRequestAction
                            pr={pr}
                            work={pullRequestWork(pr, tasks.data ?? [], backlogItems)}
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
