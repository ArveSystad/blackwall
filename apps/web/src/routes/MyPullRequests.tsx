import type {
  MergeMethod,
  MyPullRequest,
  MyPullRequestDetail,
  MyPullRequests as MyPullRequestsList,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { mergePullRequest } from "../api";
import { CiChecksList } from "../components/CiChecksList";
import { listPane, paneBody, paneHeader, paneTitle } from "../components/classes";
import { EmptyState } from "../components/EmptyState";
import {
  CheckIcon,
  CloseIcon,
  FailedIcon,
  SpinnerIcon,
  WallIcon,
  WarnIcon,
} from "../components/icons";
import { Markdown } from "../components/Markdown";
import { ORIGIN_ICONS } from "../components/origins";
import { OutboundAction } from "../components/OutboundAction";
import { RefreshButton } from "../components/RefreshButton";
import { Section } from "../components/Section";
import { Segmented } from "../components/Segmented";
import { pill } from "../components/StatusBadge";
import { Button } from "../components/ui/button";
import { ErrorText } from "../components/ui/field";
import { Kbd } from "../components/ui/kbd";
import { useWithCredential } from "../credentials";
import { useNow } from "../hooks";
import { relativeTime } from "../inbox";
import {
  isEscapeToLeave,
  isModKey,
  isTypingTarget,
  modKeyLabel,
  useWindowKeydown,
} from "../keyboard";
import { cn } from "../lib/utils";
import {
  MERGE_METHOD_LABELS,
  checksLabel,
  forgetUnlisted,
  hasUnseenActivity,
  markSeen,
  mergeWarnings,
  pullRequestName,
  reviewDecisionLabel,
  reviewDecisionTone,
  useSeenPullRequests,
} from "../my-pull-requests";
import { myPullRequestQuery, myPullRequestsQuery, queryKeys } from "../query";
import { groupByHost } from "../review-requests";
import { errorMessage } from "../settings-forms";

const PullRequestIcon = ORIGIN_ICONS["github-pr"];

/** The head commit's checks at a glance; nothing when it has none. */
function ChecksIcon({ checks }: { checks: MyPullRequest["checks"] }) {
  if (checks === null) return null;
  const label = checksLabel(checks);
  return (
    <span role="img" aria-label={label} title={label} className="flex flex-none">
      {checks === "pending" ? (
        <SpinnerIcon size="sm" className="animate-spin text-running" />
      ) : checks === "failed" ? (
        <FailedIcon size="sm" className="text-failed" />
      ) : (
        <CheckIcon size="sm" className="text-done" />
      )}
    </span>
  );
}

/** A small tag for a draft pull request. */
function DraftTag() {
  return <span className={cn(pill, "bg-muted-foreground/12 text-faint")}>Draft</span>;
}

/** One of the user's PRs; opens it beside the list. A yellow dot marks news they haven't seen. */
function PullRequestRow({
  pr,
  now,
  open,
  unseen,
}: {
  pr: MyPullRequest;
  now: Date;
  open: boolean;
  unseen: boolean;
}) {
  return (
    <li
      className={cn(
        "bw-chamfer flex items-center [--bw-chamfer-line:transparent] hover:bg-card",
        open && "bg-muted [--bw-chamfer-line:var(--border-strong)] hover:bg-muted",
      )}
    >
      <Link
        to="/pulls"
        search={{ pr: pr.url }}
        aria-current={open ? "page" : undefined}
        className="bw-chamfer bw-chamfer-focus flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-2 pl-1.5 text-foreground no-underline [--bw-chamfer-line:transparent] hover:no-underline focus-visible:outline-none"
      >
        <PullRequestIcon size="sm" className="text-muted-foreground" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            {unseen && (
              <span
                role="img"
                aria-label="New activity"
                title="New activity since you last opened it"
                className="size-2 flex-none rounded-full bg-assigned"
              />
            )}
            <span className="truncate font-medium text-foreground-strong">{pr.title}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <span className="mono truncate">
              {pr.owner}/{pr.repo}#{pr.number}
            </span>
            <time className="whitespace-nowrap" dateTime={pr.updatedAt.toISOString()}>
              {relativeTime(pr.updatedAt, now)}
            </time>
          </span>
        </span>
        <ChecksIcon checks={pr.checks} />
        {pr.draft && <DraftTag />}
        <span className={cn(pill, reviewDecisionTone(pr.reviewDecision))}>
          {reviewDecisionLabel(pr.reviewDecision)}
        </span>
      </Link>
    </li>
  );
}

/** Who wrote it and when, above a comment. */
function Byline({ author, at, now }: { author: string; at: Date | null; now: Date }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-label text-faint">
      <span className="mono truncate text-muted-foreground">{author}</span>
      {at && (
        <time className="whitespace-nowrap" dateTime={at.toISOString()}>
          {relativeTime(at, now)}
        </time>
      )}
    </span>
  );
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "review dismissed",
};

/** The PR's review status and checks, its conversation and its inline review threads. */
function PullRequestBody({ detail, now }: { detail: MyPullRequestDetail; now: Date }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-[1_1_420px] flex-col gap-4 overflow-auto px-5 py-4">
      <section aria-label="Status" className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="label text-muted-foreground">Status</span>
          <span className={cn(pill, reviewDecisionTone(detail.reviewDecision))}>
            {reviewDecisionLabel(detail.reviewDecision)}
          </span>
          {detail.draft && <DraftTag />}
          <span className="flex-1" />
          <span className="mono text-meta text-faint">{detail.headSha.slice(0, 7)}</span>
        </span>
        <CiChecksList checks={detail.checks} />
        {detail.checksHint ? (
          <p className="m-0 text-meta text-muted-foreground">{detail.checksHint}</p>
        ) : (
          detail.checks.length === 0 && (
            <p className="m-0 text-meta text-muted-foreground">No checks on the head commit.</p>
          )
        )}
      </section>

      <section aria-label="Conversation" className="flex flex-col gap-2">
        <span className="label text-muted-foreground">Conversation</span>
        {detail.conversation.length === 0 ? (
          <p className="m-0 text-meta text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {detail.conversation.map((item) => (
              <li
                key={`${item.kind}:${item.id}`}
                className="bw-chamfer-box flex flex-col gap-1.5 bg-card px-3 py-2 [--bw-chamfer-line:var(--border)]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Byline author={item.author} at={item.createdAt} now={now} />
                  {item.reviewState && (
                    <span className="text-label text-muted-foreground">
                      {REVIEW_STATE_LABELS[item.reviewState] ?? item.reviewState.toLowerCase()}
                    </span>
                  )}
                  <span className="flex-1" />
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-label">
                    GitHub ↗
                  </a>
                </span>
                <Markdown className="break-words">{item.body}</Markdown>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.threads.length > 0 && (
        <section aria-label="Review comments" className="flex flex-col gap-2">
          <span className="label text-muted-foreground">Review comments</span>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {detail.threads.map((thread) => (
              <li
                key={thread.id}
                className="bw-chamfer-box flex flex-col gap-2 bg-card px-3 py-2 [--bw-chamfer-line:var(--border)]"
              >
                <span className="flex min-w-0 items-center gap-2 text-meta">
                  <span className="mono truncate text-foreground">
                    {thread.path}
                    {thread.line !== null && `:${thread.line}`}
                  </span>
                  {thread.outdated && (
                    <span className={cn(pill, "bg-muted-foreground/12 text-faint")}>Outdated</span>
                  )}
                  <span className="flex-1" />
                  {thread.url && (
                    <a href={thread.url} target="_blank" rel="noreferrer" className="text-label">
                      GitHub ↗
                    </a>
                  )}
                </span>
                {thread.comments.map((comment) => (
                  <div key={comment.id} className="flex flex-col gap-1">
                    <Byline author={comment.author} at={comment.createdAt} now={now} />
                    <Markdown className="break-words">{comment.body}</Markdown>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Finish for one of the user's PRs, like a task's: the merge it would do,
 * exactly where, with the method picked from those the repo allows. Nothing
 * is merged until the user confirms; GitHub's refusal shows here.
 */
function MergeFinish({ detail }: { detail: MyPullRequestDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const withCredential = useWithCredential();
  const [ticked, setTicked] = useState(true);
  const [method, setMethod] = useState<MergeMethod>(detail.mergeMethods[0]!);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = pullRequestName(detail.url);
  const warnings = mergeWarnings(detail);
  const busy = merging || !ticked;

  async function merge() {
    if (busy) return;
    setMerging(true);
    setError(null);
    try {
      await withCredential({ label: "Merge pull request", target: name }, () =>
        mergePullRequest({ url: detail.url, method, sha: detail.headSha }),
      );
      queryClient.setQueryData<MyPullRequestsList>(queryKeys.myPullRequests, (data) =>
        data
          ? { ...data, pullRequests: data.pullRequests.filter((pr) => pr.url !== detail.url) }
          : data,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.myPullRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      void navigate({ to: "/pulls" });
    } catch (cause) {
      setError(errorMessage(cause));
      setMerging(false);
    }
  }

  useWindowKeydown((event) => {
    if (event.key !== "Enter" || !isModKey(event) || isTypingTarget(event.target)) return;
    event.preventDefault();
    void merge();
  }, !busy);

  return (
    <aside
      aria-label="Outbound actions"
      className="flex h-full max-w-[500px] min-w-0 flex-[1_1_360px] flex-col border-l border-border bg-sidebar/40"
    >
      <div className="flex flex-col gap-1 border-b border-border px-[18px] pt-3.5 pb-3">
        <span className="flex items-center gap-2">
          <WallIcon size="lg" className="text-magenta" />
          <span className="label text-magenta">Outbound · crosses the wall</span>
        </span>
        <span className="text-[12.5px] text-foreground">Nothing is merged until you confirm.</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto px-3.5 py-3">
        <OutboundAction
          title="Merge pull request"
          target={`${name}: ${detail.base} ← ${detail.head}`}
          checked={ticked}
          disabled={merging}
          onChange={setTicked}
        >
          <Segmented
            label="Merge method"
            value={method}
            options={detail.mergeMethods.map((value) => ({
              value,
              label: MERGE_METHOD_LABELS[value],
            }))}
            onChange={setMethod}
            disabled={busy}
          />
        </OutboundAction>
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-4 pt-3 pb-3.5">
        {warnings.map((warning) => (
          <p key={warning} className="m-0 flex items-start gap-2 text-meta text-failed">
            <WarnIcon size="sm" className="mt-[2px] flex-none" />
            <span>{warning}</span>
          </p>
        ))}
        {detail.mergeable === null && (
          <p className="m-0 text-meta text-muted-foreground">
            Mergeability unknown: GitHub is still checking it for conflicts.
          </p>
        )}
        <p className="m-0 text-meta text-muted-foreground">
          Merging also finishes the blackwall task that opened it, if any.
        </p>
        {error && <ErrorText>{error}</ErrorText>}
        <Button
          variant="needs"
          className="h-9 justify-center text-body"
          disabled={busy}
          onClick={() => void merge()}
        >
          {merging && <SpinnerIcon size="sm" className="animate-spin" />}
          {merging ? "Merging…" : ticked ? "Merge" : "Nothing to merge"}
          {!busy && (
            <Kbd onFill aria-hidden="true">
              {modKeyLabel("↵")}
            </Kbd>
          )}
        </Button>
      </div>
    </aside>
  );
}

/**
 * One of the user's PRs beside the list. Opening it marks its news seen, and
 * again when news arrives while it stays open.
 */
function MyPullRequestPane({ url, row }: { url: string; row: MyPullRequest | undefined }) {
  const detail = useQuery(myPullRequestQuery(url));
  const now = useNow();
  const activityAt = row?.activityAt ?? null;
  const checks = row?.checks ?? null;
  const listed = row !== undefined;
  useEffect(() => {
    if (listed) markSeen({ url, activityAt, checks });
  }, [url, listed, activityAt, checks]);

  return (
    <section aria-label="Pull request" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* `pr-14` keeps the last control clear of the window's close button. */}
      <div className={cn(paneHeader, "bg-sidebar/40 pr-14")}>
        <span className="flex min-w-0 flex-1 flex-col">
          <h2 className={cn(paneTitle, "text-body")}>
            {detail.data?.title ?? row?.title ?? pullRequestName(url)}
          </h2>
          <span className="flex min-w-0 items-center gap-2 text-label text-faint">
            <a href={url} target="_blank" rel="noreferrer" className="mono truncate">
              {pullRequestName(url)} ↗
            </a>
            {detail.data && (
              <span className="mono truncate">
                {detail.data.base} ← {detail.data.head}
              </span>
            )}
          </span>
        </span>
        <RefreshButton fetching={detail.isFetching} onRefresh={() => void detail.refetch()} />
        <Button size="sm" variant="ghost" asChild>
          <Link to="/pulls" aria-label="Close pull request">
            <CloseIcon size="sm" />
          </Link>
        </Button>
      </div>
      {detail.isPending ? (
        <EmptyState key="loading" role="status" title="Fetching the pull request…" />
      ) : detail.isError ? (
        <EmptyState
          key="error"
          role="alert"
          title="Could not load the pull request"
          onRetry={() => void detail.refetch()}
        >
          {detail.error.message}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap">
          <PullRequestBody detail={detail.data} now={now} />
          {/* Keyed by head so the picker and errors start over when it moves. */}
          <MergeFinish key={`${url}@${detail.data.headSha}`} detail={detail.data} />
        </div>
      )}
    </section>
  );
}

/**
 * Open pull requests the user wrote across every GitHub host, grouped by
 * host, with their checks and review status. Polled, since GitHub sends no
 * live events. `openUrl` opens one beside the list to read its reviews and
 * merge it.
 */
export function MyPullRequests({ openUrl }: { openUrl?: string | undefined }) {
  const navigate = useNavigate();
  const pulls = useQuery(myPullRequestsQuery);
  const now = useNow();
  const seen = useSeenPullRequests();
  const rows = pulls.data?.pullRequests;
  const groups = useMemo(() => groupByHost(rows ?? []), [rows]);
  const data = pulls.data;
  useEffect(() => {
    if (data && data.errors.length === 0) forgetUnlisted(data.pullRequests.map((pr) => pr.url));
  }, [data]);

  // Escape closes the open pull request first; the window's own Escape leaves for the grid after.
  // Capture phase, so it runs before the window's listener whichever mounted first.
  useWindowKeydown(
    (event) => {
      if (!isEscapeToLeave(event) || document.querySelector("[role=dialog]")) return;
      event.preventDefault();
      void navigate({ to: "/pulls" });
    },
    Boolean(openUrl),
    true,
  );

  return (
    <div className="flex h-full min-w-0">
      <div
        className={cn(
          "flex h-full min-w-0 flex-col",
          openUrl ? cn(listPane, "bg-sidebar/40") : "flex-1",
        )}
      >
        {/* `pr-14` keeps the last control clear of the window's close button. */}
        <div className={cn(paneHeader, "bg-sidebar/40", !openUrl && "pr-14")}>
          <h1 className={paneTitle}>My pull requests</h1>
          {pulls.data && (
            <span className="mono text-label text-faint">
              {pulls.data.pullRequests.length} open
            </span>
          )}
          <span className="flex-1" />
          <RefreshButton fetching={pulls.isFetching} onRefresh={() => void pulls.refetch()} />
        </div>

        <div className={paneBody}>
          {pulls.isPending ? (
            <EmptyState key="loading" role="status" title="Fetching your pull requests…" />
          ) : pulls.isError ? (
            <EmptyState
              key="error"
              role="alert"
              title="Could not load pull requests"
              onRetry={() => void pulls.refetch()}
            >
              {pulls.error.message}
            </EmptyState>
          ) : (
            <>
              {pulls.data.errors.map((error) => (
                <EmptyState
                  key={`error:${error.host}`}
                  role="alert"
                  title={`Could not load pull requests from ${error.host}`}
                  className="flex-none"
                  onRetry={() => void pulls.refetch()}
                >
                  {error.message}
                </EmptyState>
              ))}
              {groups.length === 0
                ? pulls.data.errors.length === 0 && (
                    <EmptyState key="empty" title="All clear. No open pull requests.">
                      Open PRs you wrote, drafts included, on every GitHub host with a token.
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
                        <PullRequestRow
                          key={pr.url}
                          pr={pr}
                          now={now}
                          open={pr.url === openUrl}
                          unseen={hasUnseenActivity(pr, seen)}
                        />
                      ))}
                    </Section>
                  ))}
            </>
          )}
        </div>
      </div>
      {openUrl && (
        <MyPullRequestPane
          key={openUrl}
          url={openUrl}
          row={rows?.find((pr) => pr.url === openUrl)}
        />
      )}
    </div>
  );
}
