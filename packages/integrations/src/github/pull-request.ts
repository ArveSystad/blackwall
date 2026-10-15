import type {
  GitHubClient,
  GitHubIssueCommentJson,
  GitHubPullRequestJson,
  GitHubReviewCommentJson,
  GitHubReviewJson,
  PullRequestCoordinates,
} from "./client.js";
import { author, byCreated, day, demote, fence, sectionOf } from "./markdown.js";

/** An inline review comment, grouped into its thread. */
export interface PullRequestReviewComment {
  author: string;
  body: string;
  created: string | null;
}

/** Inline comments on one spot of the diff: the first comment and its replies. */
export interface PullRequestReviewThread {
  path: string;
  line: number | null;
  /** Diff context GitHub stores with the first comment. */
  diffHunk: string | null;
  comments: PullRequestReviewComment[];
}

export interface PullRequestConversationItem {
  author: string;
  body: string;
  created: string | null;
  /** Set for review summaries: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`. */
  reviewState?: string;
}

/** Everything Inform needs from a pull request, flattened from the REST payloads. */
export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  description: string;
  state: string;
  draft: boolean;
  author: string | null;
  labels: string[];
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head branch; differs from the base for a fork. */
  headRepo: string | null;
  baseRef: string;
  stats: { additions: number; deletions: number; changedFiles: number } | null;
  diff: string;
  threads: PullRequestReviewThread[];
  conversation: PullRequestConversationItem[];
}

export interface PullRequestPayloads {
  pullRequest: GitHubPullRequestJson;
  diff: string;
  reviewComments: readonly GitHubReviewCommentJson[];
  issueComments: readonly GitHubIssueCommentJson[];
  reviews: readonly GitHubReviewJson[];
}

/** One comment in a {@link ReviewThread}. */
export interface ReviewThreadComment {
  id: number;
  author: string;
  body: string;
  created: string | null;
}

/** An inline review thread as GitHub stores it: the root comment's position and every reply. */
export interface ReviewThread {
  /** The root comment's id. */
  id: number;
  path: string;
  /** Line on the PR's current head; null once GitHub marks the thread outdated. */
  line: number | null;
  /** Line on the commit the thread was first written against. */
  originalLine: number | null;
  /** First line of a multi-line comment. */
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  outdated: boolean;
  /** The root comment's page on GitHub. */
  url: string | null;
  /** Diff context GitHub stores with the first comment. */
  diffHunk: string | null;
  /** Oldest first. */
  comments: ReviewThreadComment[];
}

/** Groups inline review comments into threads: replies under their root, oldest first. */
export function groupReviewThreads(
  reviewComments: readonly GitHubReviewCommentJson[],
): ReviewThread[] {
  const threads = new Map<number, ReviewThread>();
  const sorted = [...reviewComments].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  );
  for (const c of sorted) {
    const comment = {
      id: c.id,
      author: author(c.user),
      body: c.body.trim(),
      created: c.created_at ?? null,
    };
    const parent = c.in_reply_to_id !== undefined ? threads.get(c.in_reply_to_id) : undefined;
    if (parent) {
      parent.comments.push(comment);
      threads.set(c.id, parent);
      continue;
    }
    const line = c.line ?? null;
    threads.set(c.id, {
      id: c.id,
      path: c.path,
      line,
      originalLine: c.original_line ?? null,
      startLine: c.start_line ?? null,
      side: c.side === "LEFT" ? "LEFT" : "RIGHT",
      outdated: line === null,
      url: c.html_url ?? null,
      diffHunk: c.diff_hunk ?? null,
      comments: [comment],
    });
  }
  return [...new Set(threads.values())];
}

/** A PR's conversation comments and review summaries, oldest first. */
export function conversationOf(
  issueComments: readonly GitHubIssueCommentJson[],
  reviews: readonly GitHubReviewJson[],
): PullRequestConversationItem[] {
  return [
    ...issueComments.map((c) => ({
      author: author(c.user),
      body: (c.body ?? "").trim(),
      created: c.created_at ?? null,
    })),
    // Reviews without a summary (just inline comments) and pending reviews add nothing here.
    ...reviews
      .filter((r) => r.state !== "PENDING" && (r.body ?? "").trim() !== "")
      .map((r) => ({
        author: author(r.user),
        body: (r.body ?? "").trim(),
        created: r.submitted_at ?? null,
        reviewState: r.state,
      })),
  ]
    .filter((item) => item.body !== "")
    .sort(byCreated);
}

/** Builds the context from the recorded REST payloads (pure, so it is fixture-testable). */
export function assemblePullRequest(
  pr: PullRequestCoordinates,
  { pullRequest, diff, reviewComments, issueComments, reviews }: PullRequestPayloads,
): PullRequestContext {
  const threads = groupReviewThreads(reviewComments).map((t): PullRequestReviewThread => ({
    path: t.path,
    line: t.line ?? t.originalLine,
    diffHunk: t.diffHunk,
    comments: t.comments.map(({ author, body, created }) => ({ author, body, created })),
  }));
  const conversation = conversationOf(issueComments, reviews);

  return {
    owner: pr.owner,
    repo: pr.repo,
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    description: (pullRequest.body ?? "").trim(),
    state: pullRequest.merged ? "merged" : pullRequest.state,
    draft: pullRequest.draft ?? false,
    author: pullRequest.user?.login ?? null,
    labels: (pullRequest.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    headRepo: pullRequest.head.repo?.full_name ?? null,
    baseRef: pullRequest.base.ref,
    stats:
      pullRequest.additions !== undefined
        ? {
            additions: pullRequest.additions,
            deletions: pullRequest.deletions ?? 0,
            changedFiles: pullRequest.changed_files ?? 0,
          }
        : null,
    diff,
    threads,
    conversation,
  };
}

/** Fetches the PR, its diff, inline review comments, conversation and reviews. */
export async function fetchPullRequest(
  client: GitHubClient,
  pr: PullRequestCoordinates,
  signal?: AbortSignal,
): Promise<PullRequestContext> {
  const [pullRequest, diff, reviewComments, issueComments, reviews] = await Promise.all([
    client.getPullRequest(pr, signal),
    client.getPullRequestDiff(pr, signal),
    client.listReviewComments(pr, signal),
    client.listIssueComments(pr, signal),
    client.listReviews(pr, signal),
  ]);
  return assemblePullRequest(pr, { pullRequest, diff, reviewComments, issueComments, reviews });
}

const JIRA_KEY_IN_TEXT = /(?:^|[^A-Za-z0-9])([A-Z][A-Z0-9_]*-\d+)(?![A-Za-z0-9])/;

const KEY_AT_START = /^([A-Za-z][A-Za-z0-9_]*-\d+)(?![A-Za-z0-9])/;

/**
 * The Jira key a PR refers to: one starting a segment of its head branch
 * (`feature/abc-123-…`, `ABC-123-…`, any case), or else one in its title
 * (`ABC-123: …`, upper case only, so words like `utf-8` don't count).
 * Undefined when neither has one. It can still be a false positive
 * (`deps/lodash-4.17`), so callers treat a missing issue as no issue.
 */
export function findJiraKey(branch: string, title: string): string | undefined {
  const fromBranch = branch
    .split("/")
    .map((part) => KEY_AT_START.exec(part)?.[1])
    .find((key) => key !== undefined);
  return fromBranch?.toUpperCase() ?? JIRA_KEY_IN_TEXT.exec(title)?.[1];
}

/** Diffs beyond this many characters are cut in the prompt; the agent can run `git diff`. */
export const MAX_PROMPT_DIFF_CHARS = 200_000;

export interface RenderPullRequestOptions {
  maxDiffChars?: number;
}

/** The pull request as markdown for the Inform prompt. */
export function renderPullRequest(
  pr: PullRequestContext,
  { maxDiffChars = MAX_PROMPT_DIFF_CHARS }: RenderPullRequestOptions = {},
): string {
  const facts = [
    `State: ${pr.draft ? "draft" : pr.state}`,
    pr.author ? `Author: ${pr.author}` : "",
    `Branch: ${pr.headRef} → ${pr.baseRef}`,
    pr.headRepo && pr.headRepo.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()
      ? `Fork: ${pr.headRepo}`
      : "",
    pr.labels.length > 0 ? `Labels: ${pr.labels.join(", ")}` : "",
    pr.stats
      ? `Changes: +${pr.stats.additions} −${pr.stats.deletions} in ${pr.stats.changedFiles} file${pr.stats.changedFiles === 1 ? "" : "s"}`
      : "",
  ].filter(Boolean);

  const truncated = pr.diff.length > maxDiffChars;
  const diff = pr.diff.trim()
    ? `${fence(truncated ? pr.diff.slice(0, maxDiffChars) : pr.diff, "diff")}${
        truncated
          ? `\n\nThe diff is cut at ${maxDiffChars} of ${pr.diff.length} characters. Run \`git diff origin/${pr.baseRef}...HEAD\` in the worktree for the rest.`
          : ""
      }`
    : "";

  return [
    `## Pull request ${pr.owner}/${pr.repo}#${pr.number}: ${pr.title}`,
    `${facts.join(" · ")}\n${pr.url}`,
    sectionOf("Description", demote(pr.description, 4)),
    sectionOf("Conversation", renderConversation(pr.conversation)),
    sectionOf("Review comments", renderThreads(pr.threads)),
    sectionOf("Diff", diff),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderThreads(threads: readonly PullRequestReviewThread[]): string {
  return threads
    .map((t) => {
      const where = `\`${t.path}${t.line ? `:${t.line}` : ""}\``;
      const comments = t.comments
        .map((c) => `**${c.author}**${day(c.created)}:\n\n${demote(c.body, 4)}`)
        .join("\n\n");
      return `#### ${where}\n\n${t.diffHunk ? `${fence(t.diffHunk, "diff")}\n\n` : ""}${comments}`;
    })
    .join("\n\n---\n\n");
}

function renderConversation(conversation: readonly PullRequestConversationItem[]): string {
  return conversation
    .map((c) => {
      const verdict = c.reviewState ? ` [review: ${c.reviewState.toLowerCase()}]` : "";
      return `**${c.author}**${day(c.created)}${verdict}:\n\n${demote(c.body, 4)}`;
    })
    .join("\n\n---\n\n");
}

/**
 * The PR's conversation and inline review comments as markdown, without the
 * description or diff; `""` when there are none.
 */
export function renderPullRequestComments(
  pr: Pick<PullRequestContext, "threads" | "conversation">,
): string {
  return [
    sectionOf("Conversation", renderConversation(pr.conversation)),
    sectionOf("Review comments", renderThreads(pr.threads)),
  ]
    .filter(Boolean)
    .join("\n\n");
}
