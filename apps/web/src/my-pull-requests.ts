import type {
  MergeMethod,
  MyPullRequest,
  MyPullRequestDetail,
  PullRequestReviewer,
} from "@blackwall/shared";
import { useSyncExternalStore } from "react";
import { plural } from "./backlog";
import type { DiffLine } from "./task-view";

type ReviewDecision = MyPullRequest["reviewDecision"];
type Checks = MyPullRequest["checks"];

/** The home pill's full label, also its accessible name. */
export function myPrPillLabel(count: number): string {
  if (count === 0) return "No pull requests of yours are open";
  return `${plural(count, "pull request")} of yours ${count === 1 ? "is" : "are"} open`;
}

/** The review status pill's label; a repo without required reviews has no decision. */
export function reviewDecisionLabel(decision: ReviewDecision): string {
  switch (decision) {
    case "approved":
      return "Approved";
    case "changes-requested":
      return "Changes requested";
    case "review-required":
      return "Review required";
    case null:
      return "No review required";
  }
}

/** The review status pill's tone: green once approved, red when changes are asked for. */
export function reviewDecisionTone(decision: ReviewDecision): string {
  switch (decision) {
    case "approved":
      return "bg-done/12 text-done";
    case "changes-requested":
      return "bg-failed/12 text-failed";
    default:
      return "bg-muted-foreground/12 text-muted-foreground";
  }
}

/** Reviewers by display name, falling back to login: "A", "A and B", "A, B +2". */
export function reviewerNames(reviewers: readonly PullRequestReviewer[]): string {
  const names = reviewers.map((r) => r.name ?? r.login);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** The review status pill: who approved or asked for changes, in the decision's tone. */
export interface ReviewStatus {
  label: string;
  tone: string;
  icon: "check" | "failed" | null;
}

/**
 * The review status pill for a decision, naming the reviewers behind it. A
 * repo without required reviews still shows an approval when someone gave one.
 */
export function reviewStatus(
  decision: ReviewDecision,
  reviewers: readonly PullRequestReviewer[],
): ReviewStatus {
  const approvers = reviewerNames(reviewers.filter((r) => r.state === "approved"));
  const requesters = reviewerNames(reviewers.filter((r) => r.state === "changes-requested"));
  switch (decision) {
    case "changes-requested":
      return {
        label: requesters ? `Changes requested by ${requesters}` : "Changes requested",
        tone: reviewDecisionTone(decision),
        icon: "failed",
      };
    case "approved":
      return {
        label: approvers ? `Approved by ${approvers}` : "Approved",
        tone: reviewDecisionTone(decision),
        icon: "check",
      };
    case "review-required":
      return {
        label: approvers ? `Review required · approved by ${approvers}` : "Review required",
        tone: reviewDecisionTone(decision),
        icon: null,
      };
    case null:
      return approvers
        ? { label: `Approved by ${approvers}`, tone: reviewDecisionTone("approved"), icon: "check" }
        : { label: reviewDecisionLabel(null), tone: reviewDecisionTone(null), icon: null };
  }
}

/** Fewest and most lines of code a review thread shows above its first comment. */
const EXCERPT_MIN_LINES = 4;
const EXCERPT_MAX_LINES = 20;

/**
 * Numbers the lines of a bare hunk such as GitHub's `diff_hunk`, by their
 * first character only: a deleted `-- x` or added `++ x` is not a file
 * header here. Hunk headers set the numbering and are not emitted.
 */
function parseHunk(diffHunk: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diffHunk.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      inHunk = true;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
    } else if (!inHunk) {
      continue;
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), line: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), line: oldLine++ });
    } else if (raw.startsWith(" ") || raw === "") {
      lines.push({ kind: "ctx", text: raw.slice(1), line: newLine++ });
      oldLine++;
    }
  }
  // A trailing empty line from the split is not context.
  const last = lines.at(-1);
  if (last?.kind === "ctx" && last.text === "") lines.pop();
  return lines;
}

/**
 * The code a review thread comments on, from GitHub's `diff_hunk` (which
 * ends on the commented line): the last few lines, or the whole commented
 * range when longer, at most {@link EXCERPT_MAX_LINES}. The range is measured
 * in new-file lines; deleted lines inside it are kept. Empty without a hunk.
 */
export function hunkExcerpt(
  diffHunk: string | null,
  startLine: number | null,
  line: number | null,
): DiffLine[] {
  if (!diffHunk) return [];
  const lines = parseHunk(diffHunk);
  const top = startLine !== null && line !== null ? startLine : null;
  let start = lines.length;
  let covered = top === null;
  while (start > 0 && lines.length - start < EXCERPT_MAX_LINES) {
    if (covered && lines.length - start >= EXCERPT_MIN_LINES) break;
    const prev = lines[--start];
    if (top !== null && prev && prev.kind !== "del" && prev.line !== null && prev.line <= top) {
      covered = true;
    }
  }
  return lines.slice(start);
}

/** What the head commit's checks say, for the row's checks icon. */
export function checksLabel(checks: Checks): string {
  switch (checks) {
    case "pending":
      return "Checks running";
    case "passed":
      return "Checks passed";
    case "failed":
      return "Checks failed";
    case null:
      return "No checks";
  }
}

/** The merge picker's labels, as GitHub names the methods. */
export const MERGE_METHOD_LABELS: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};

/** `owner/repo#n` for a pull request link; the link itself when it isn't one. */
export function pullRequestName(url: string): string {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/.exec(url);
  return match ? `${match[1]}/${match[2]}#${match[3]}` : url;
}

/**
 * Why merging may not be wise right now, for the Finish aside: not approved,
 * checks failing or still running, a draft, or conflicts. GitHub enforces
 * the rules; these only inform.
 */
export function mergeWarnings(
  detail: Pick<MyPullRequestDetail, "reviewDecision" | "checks" | "draft" | "mergeable" | "base">,
): string[] {
  const warnings: string[] = [];
  if (detail.reviewDecision === "changes-requested") warnings.push("A reviewer asked for changes.");
  if (detail.reviewDecision === "review-required") warnings.push("It isn't approved yet.");
  if (detail.checks.some((c) => c.state === "failed")) warnings.push("Checks are failing.");
  else if (detail.checks.some((c) => c.state === "pending")) {
    warnings.push("Checks are still running.");
  }
  if (detail.draft) warnings.push("It is a draft.");
  if (detail.mergeable === false) warnings.push(`It has conflicts with ${detail.base}.`);
  return warnings;
}

/** What the user last saw of a pull request, when they last opened it. */
export interface SeenEntry {
  activityAt: string | null;
  checks: Checks;
}

/** Seen pull requests by URL. */
export type SeenMap = Readonly<Record<string, SeenEntry>>;

/** Remembered per browser, like the selected repo and drafts. */
export const MY_PRS_SEEN_STORAGE_KEY = "bw:my-prs-seen";

const CHECKS: readonly Checks[] = ["pending", "passed", "failed", null];

function isSeenEntry(value: unknown): value is SeenEntry {
  if (!value || typeof value !== "object") return false;
  const { activityAt, checks } = value as Record<string, unknown>;
  return (
    (activityAt === null || typeof activityAt === "string") && CHECKS.includes(checks as Checks)
  );
}

/** The stored seen map; unreadable or malformed storage means nothing was seen. */
export function loadSeen(): SeenMap {
  try {
    const raw = globalThis.localStorage?.getItem(MY_PRS_SEEN_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => isSeenEntry(entry)));
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let current: SeenMap | undefined;

function seenNow(): SeenMap {
  if (current === undefined) current = loadSeen();
  return current;
}

function saveSeen(next: SeenMap): void {
  current = next;
  try {
    globalThis.localStorage?.setItem(MY_PRS_SEEN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage is a convenience; the seen state still applies for this page.
  }
  for (const listener of listeners) listener();
}

/** Records that the user opened the pull request as it is now. */
export function markSeen(pr: Pick<MyPullRequest, "url" | "activityAt" | "checks">): void {
  const seen = seenNow();
  const entry = seen[pr.url];
  if (entry && entry.activityAt === pr.activityAt && entry.checks === pr.checks) return;
  saveSeen({ ...seen, [pr.url]: { activityAt: pr.activityAt, checks: pr.checks } });
}

/** The entries of the pull requests still listed. */
export function pruneSeen(seen: SeenMap, urls: readonly string[]): SeenMap {
  const listed = new Set(urls);
  return Object.fromEntries(Object.entries(seen).filter(([url]) => listed.has(url)));
}

/** Forgets the pull requests no longer listed. */
export function forgetUnlisted(urls: readonly string[]): void {
  const seen = seenNow();
  const kept = pruneSeen(seen, urls);
  if (Object.keys(kept).length !== Object.keys(seen).length) saveSeen(kept);
}

/**
 * Whether the pull request has news the user hasn't looked at: a newer review
 * or comment from someone else, or checks that settled since they last opened
 * it. One never opened has news only when someone else has been active on it.
 */
export function hasUnseenActivity(
  pr: Pick<MyPullRequest, "url" | "activityAt" | "checks">,
  seen: SeenMap,
): boolean {
  const entry = seen[pr.url];
  if (!entry) return pr.activityAt !== null;
  if (
    pr.activityAt !== null &&
    (entry.activityAt === null || Date.parse(pr.activityAt) > Date.parse(entry.activityAt))
  ) {
    return true;
  }
  return (pr.checks === "passed" || pr.checks === "failed") && pr.checks !== entry.checks;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const NONE_SEEN: SeenMap = {};

/** The seen map, re-rendering when a pull request is marked seen. */
export function useSeenPullRequests(): SeenMap {
  return useSyncExternalStore(subscribe, seenNow, () => NONE_SEEN);
}
