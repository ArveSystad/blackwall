import type { Task } from "@blackwall/shared";
import type { NewFinding } from "../db/schema.js";
import { fence, firstLineTitle } from "./stages.js";

/** One comment of a pull request, with its canonical permalink. */
export interface PullRequestFeedbackComment {
  /** `<pr>#discussion_r<id>`, `<pr>#issuecomment-<id>` or `<pr>#pullrequestreview-<id>`. */
  url: string;
  author: string;
  body: string;
}

/** An inline review thread on the pull request, outdated or not. */
export interface PullRequestFeedbackThread {
  path: string;
  /** Line on the PR's current head; null once GitHub marks the thread outdated. */
  line: number | null;
  /** First line of a multi-line comment. */
  startLine: number | null;
  /** Line on the commit the thread was first written against. */
  originalLine: number | null;
  side: "LEFT" | "RIGHT";
  outdated: boolean;
  /** The root comment's permalink. */
  url: string;
  diffHunk: string | null;
  /** Oldest first. */
  comments: PullRequestFeedbackComment[];
}

/** A conversation comment or review summary on the pull request. */
export interface PullRequestFeedbackItem extends PullRequestFeedbackComment {
  /** Set for review summaries: `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`. */
  reviewState?: string;
}

/** The comments on a task's pull request that someone other than blackwall wrote. */
export interface PullRequestFeedback {
  threads: PullRequestFeedbackThread[];
  /** Oldest first. */
  conversation: PullRequestFeedbackItem[];
}

/** Most findings one Fetch comments and fix creates; the rest come on the next click. */
export const MAX_PR_COMMENT_FINDINGS = 20;

const COMMENT_LINE = /Comment: (\S+#(?:discussion_r|issuecomment-|pullrequestreview-)\d+)/g;

const INSTRUCTION =
  "Address the new review comments; if one is already addressed or you disagree, leave the code and say why in your summary.";

/** The PR comment permalinks findings already carry, so a comment is fixed only once. */
export function seenPrCommentUrls(findings: readonly { explanation: string }[]): Set<string> {
  const seen = new Set<string>();
  for (const f of findings) {
    for (const match of f.explanation.matchAll(COMMENT_LINE)) seen.add(match[1]!);
  }
  return seen;
}

const quote = (c: { author: string; body: string }, state?: string) =>
  `**${c.author}**${state ? ` (${state})` : ""}: ${c.body}`;

const newComment = (c: PullRequestFeedbackComment, state?: string) =>
  `${quote(c, state)}\n\nComment: ${c.url}`;

function prFinding(
  task: Task,
  runId: string,
  round: number,
  fields: Pick<NewFinding, "file" | "lineStart" | "lineEnd" | "title" | "explanation">,
): NewFinding {
  return {
    taskId: task.id,
    runId,
    stepId: null,
    reviewerAgentId: null,
    severity: "high",
    tags: [],
    suggestedFix: null,
    status: "force-fix",
    round,
    ...fields,
  };
}

/**
 * The force-fixed finding for a review thread's comments not in `seen`, with
 * its earlier comments as context; undefined when it has none. Only a current
 * thread on the PR's new side gets line numbers: an outdated or base-side one
 * names its file and says where it was instead.
 */
export function prThreadFinding(
  task: Task,
  runId: string,
  round: number,
  thread: PullRequestFeedbackThread,
  seen: ReadonlySet<string>,
): NewFinding | undefined {
  const fresh = thread.comments.filter((c) => !seen.has(c.url));
  if (fresh.length === 0) return undefined;
  const earlier = thread.comments.filter((c) => seen.has(c.url));
  const placed = thread.side === "RIGHT" && !thread.outdated && thread.line !== null;
  const lines = thread.startLine !== null ? `${thread.startLine}–${thread.line}` : thread.line;
  const note = thread.outdated
    ? `Outdated thread (originally line ${thread.originalLine ?? "unknown"}); the code has changed since.`
    : thread.side === "LEFT"
      ? `Comment on the removed/base side, line ${lines}.`
      : "";
  const explanation = [
    note,
    earlier.length > 0
      ? `Earlier in this thread (already handled):\n\n${earlier.map((c) => quote(c)).join("\n\n")}`
      : "",
    `New:\n\n${fresh.map((c) => newComment(c)).join("\n\n")}`,
    thread.diffHunk ? fence(thread.diffHunk, "diff") : "",
    INSTRUCTION,
  ]
    .filter(Boolean)
    .join("\n\n");
  return prFinding(task, runId, round, {
    file: thread.path,
    lineStart: placed ? (thread.startLine ?? thread.line) : null,
    lineEnd: placed ? thread.line : null,
    title: `PR comment: ${firstLineTitle(fresh[0]!.body)}`,
    explanation,
  });
}

/**
 * The force-fixed finding for the PR conversation's comments and review
 * summaries not in `seen`; undefined when there are none.
 */
export function prConversationFinding(
  task: Task,
  runId: string,
  round: number,
  prNumber: number,
  items: readonly PullRequestFeedbackItem[],
  seen: ReadonlySet<string>,
): NewFinding | undefined {
  const fresh = items.filter((c) => !seen.has(c.url));
  if (fresh.length === 0) return undefined;
  return prFinding(task, runId, round, {
    file: null,
    lineStart: null,
    lineEnd: null,
    title: `PR conversation on #${prNumber}`,
    explanation: [...fresh.map((c) => newComment(c, c.reviewState)), INSTRUCTION].join("\n\n"),
  });
}
