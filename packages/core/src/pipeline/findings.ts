import { SEVERITIES, isGatingSeverity, type Finding, type Severity } from "@blackwall/shared";
import type { FindingPatch } from "../db/repositories.js";

/**
 * Findings the next fix round must address: open Critical/High ones and any
 * the user force-fixed, at any severity. Force-ignored, fixed and merged
 * findings never gate.
 */
export function blockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter(
    (f) => f.status === "force-fix" || (f.status === "open" && isGatingSeverity(f.severity)),
  );
}

/** Statuses an earlier finding can have and still absorb a re-reported duplicate. */
const ACTIVE_STATUSES: readonly Finding["status"][] = ["open", "force-fix", "force-ignore"];

/** Lower is more severe. */
const rank = (severity: Severity) => SEVERITIES.indexOf(severity);

/** Lines apart two ranges may be and still point at the same code. */
const LINE_SLACK = 3;

const normalizePath = (file: string | null) =>
  file === null ? null : file.trim().replace(/\\/g, "/").replace(/^\.\//, "");

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
}

/** Jaccard similarity of two titles' words, 0..1. */
function titleSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** Whether two findings' line ranges overlap (within slack); undefined when either has none. */
function linesNear(a: Finding, b: Finding): boolean | undefined {
  if (a.lineStart === null || b.lineStart === null) return undefined;
  const aEnd = a.lineEnd ?? a.lineStart;
  const bEnd = b.lineEnd ?? b.lineStart;
  return a.lineStart <= bEnd + LINE_SLACK && b.lineStart <= aEnd + LINE_SLACK;
}

/**
 * Whether two findings report the same problem: same file, and either nearby
 * lines with a similar title or a shared tag, or (without lines) clearly
 * similar titles. Findings from the same step never match: one reviewer
 * listing two findings meant two problems.
 */
export function sameIssue(a: Finding, b: Finding): boolean {
  if (a.stepId !== null && a.stepId === b.stepId) return false;
  if (normalizePath(a.file) !== normalizePath(b.file)) return false;
  const similarity = titleSimilarity(a.title, b.title);
  if (a.file === null) return similarity >= 0.6;
  const near = linesNear(a, b);
  if (near === false) return false;
  if (near === true) return similarity >= 0.25 || a.tags.some((t) => b.tags.includes(t));
  return similarity >= 0.5;
}

/** One merge: `duplicateIds` fold into `targetId`, which takes `patch`. */
export interface FindingMerge {
  targetId: string;
  patch: FindingPatch;
  duplicateIds: string[];
}

function describeDuplicate(f: Finding): string {
  const fix = f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : "";
  return `- ${f.title}: ${f.explanation}${fix}`;
}

/**
 * The aggregation step's de-duplication. `incoming` (this round's active
 * findings) are grouped by {@link sameIssue}; each group then folds into an
 * earlier active finding for the same problem when there is one, so a
 * re-reported problem keeps the user's force-fix or force-ignore, or else
 * into the member the user overrode, or else its most severe member. The target takes the highest severity, every
 * tag and the widest line range; a target from this round also lists what
 * the duplicates said.
 */
export function planMerges(
  earlier: readonly Finding[],
  incoming: readonly Finding[],
): FindingMerge[] {
  const incomingIds = new Set(incoming.map((f) => f.id));
  const candidates = earlier.filter(
    (f) => !incomingIds.has(f.id) && ACTIVE_STATUSES.includes(f.status),
  );

  const groups: Finding[][] = [];
  const bySeverity = [...incoming].sort((a, b) => rank(a.severity) - rank(b.severity));
  for (const finding of bySeverity) {
    const group = groups.find((g) => g.every((member) => sameIssue(member, finding)));
    if (group) group.push(finding);
    else groups.push([finding]);
  }

  const merges: FindingMerge[] = [];
  for (const group of groups) {
    const primary = group[0]!;
    const previous = candidates.find((f) => sameIssue(f, primary));
    // The user's override on any member survives the merge.
    const target = previous ?? group.find((f) => f.status !== "open") ?? primary;
    const duplicates = group.filter((f) => f !== target);
    if (duplicates.length === 0) continue;

    const all = [target, ...duplicates];
    const severity = all.map((f) => f.severity).sort((a, b) => rank(a) - rank(b))[0]!;
    const tags = [...new Set(all.flatMap((f) => f.tags))];
    const sameFile = all.every((f) => normalizePath(f.file) === normalizePath(target.file));
    const starts = all.flatMap((f) => (f.lineStart === null ? [] : [f.lineStart]));
    const ends = all.flatMap((f) => {
      const end = f.lineEnd ?? f.lineStart;
      return end === null ? [] : [end];
    });

    const patch: FindingPatch = { severity, tags };
    if (sameFile && starts.length > 0) {
      patch.lineStart = Math.min(...starts);
      patch.lineEnd = Math.max(...ends);
    }
    if (target.suggestedFix === null) {
      const fix = duplicates.find((f) => f.suggestedFix !== null)?.suggestedFix;
      if (fix) patch.suggestedFix = fix;
    }
    if (!previous) {
      patch.explanation = `${target.explanation}\n\nAlso reported:\n${duplicates.map(describeDuplicate).join("\n")}`;
    }
    merges.push({ targetId: target.id, patch, duplicateIds: duplicates.map((f) => f.id) });
  }
  return merges;
}
