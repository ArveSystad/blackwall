import type { MergeMethod, MyPullRequest, MyPullRequestDetail } from "@blackwall/shared";
import { useSyncExternalStore } from "react";
import { plural } from "./backlog";

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
