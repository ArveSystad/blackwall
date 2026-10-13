import type { Finding, ReviewFinding } from "@blackwall/shared";

/** One inline comment of a review, as `POST /pulls/{n}/reviews` takes it. */
export interface ReviewCommentPayload {
  path: string;
  /** Last line of the range, on the new (RIGHT) side of the diff. */
  line: number;
  side: "RIGHT";
  /** First line of a multi-line range; omitted for a single line. */
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

/** Body of `POST /repos/{owner}/{repo}/pulls/{n}/reviews`. */
export interface ReviewPayload {
  /** Head commit the comments refer to, so they anchor to the diff that was reviewed. */
  commit_id?: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewCommentPayload[];
}

/**
 * Lines a review comment can be attached to: for each file, the new-side
 * line numbers inside the diff's hunks (added and context lines), mapped to
 * the hunk they belong to. GitHub rejects comments outside these.
 */
export type CommentableLines = Map<string, Map<number, number>>;

function diffPath(raw: string): string | undefined {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (value === "/dev/null") return undefined;
  return value.replace(/^b\//, "");
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a unified diff (`git diff` / the GitHub `.diff` media type) into {@link CommentableLines}. */
export function commentableLines(diff: string): CommentableLines {
  const files: CommentableLines = new Map();
  let current: Map<number, number> | undefined;
  let hunk = -1;
  let line = 0;
  // Lines of the current hunk still to come, per side (from the `@@` header).
  let oldLeft = 0;
  let newLeft = 0;
  for (const text of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("\\")) continue; // "\ No newline at end of file"
      if (text.startsWith("-")) {
        oldLeft -= 1;
        continue;
      }
      // Added line, or context (some tools drop the leading space of an empty one).
      if (current) current.set(line, hunk);
      line += 1;
      newLeft -= 1;
      if (!text.startsWith("+")) oldLeft -= 1;
      continue;
    }
    if (text.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (text.startsWith("+++ ")) {
      const path = diffPath(text.slice(4));
      current = undefined;
      if (path) {
        current = files.get(path) ?? new Map<number, number>();
        files.set(path, current);
      }
      continue;
    }
    const header = HUNK.exec(text);
    if (header) {
      hunk += 1;
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      line = Number(header[2]);
      newLeft = header[3] === undefined ? 1 : Number(header[3]);
    }
  }
  return files;
}

/** A finding to post; the step and reviewer, when given, tell the user's own comments apart. */
export type PostedFinding = ReviewFinding & Partial<Pick<Finding, "stepId" | "reviewerAgentId">>;

/**
 * Whether the finding is the user's own hunk comment, with neither a step nor
 * a reviewer. A finding that leaves them out is not.
 */
function isUserComment(finding: PostedFinding): boolean {
  return finding.stepId === null && finding.reviewerAgentId === null;
}

/**
 * A finding as markdown: severity and title, explanation, suggested fix and
 * tags. The user's own comment is posted as they wrote it.
 */
export function renderFindingComment(finding: PostedFinding): string {
  if (isUserComment(finding)) return finding.explanation.trim();
  const parts = [`**[${finding.severity}] ${finding.title}**`, finding.explanation.trim()];
  const fix = finding.suggestedFix?.trim();
  if (fix) parts.push(`**Suggested fix:** ${fix}`);
  if (finding.tags.length > 0) parts.push(finding.tags.map((t) => `\`${t}\``).join(" "));
  return parts.filter(Boolean).join("\n\n");
}

function location(finding: ReviewFinding): string {
  if (!finding.file) return "";
  if (!finding.lineStart) return ` (\`${finding.file}\`)`;
  const end = finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : "";
  return ` (\`${finding.file}:${finding.lineStart}${end}\`)`;
}

/** Places a finding on the diff, or returns undefined when none of its lines are commentable. */
function place(
  finding: ReviewFinding,
  lines: CommentableLines,
): Omit<ReviewCommentPayload, "body"> | undefined {
  if (!finding.file || !finding.lineStart) return undefined;
  const file = lines.get(finding.file.replace(/\\/g, "/").replace(/^\.?\//, ""));
  if (!file) return undefined;
  const start = finding.lineStart;
  const end = Math.max(finding.lineEnd ?? start, start);
  let last: number | undefined;
  for (let n = end; n >= start; n -= 1) {
    if (file.has(n)) {
      last = n;
      break;
    }
  }
  if (last === undefined) return undefined;
  // A multi-line comment must stay within one hunk.
  const hunk = file.get(last);
  let first = last;
  while (first - 1 >= start && file.get(first - 1) === hunk) first -= 1;
  return {
    path: finding.file.replace(/\\/g, "/").replace(/^\.?\//, ""),
    line: last,
    side: "RIGHT",
    ...(first < last ? { start_line: first, start_side: "RIGHT" as const } : {}),
  };
}

export interface ReviewPayloadOptions {
  /** The PR's unified diff; findings are placed on its new-side lines. */
  diff: string;
  /** Head commit the review is for. */
  commitId?: string;
  /** Text above the findings in the review body. */
  summary?: string;
  /** Defaults to `COMMENT`: the harness approves only when the user opts in, and never blocks. */
  event?: ReviewEvent;
}

/**
 * Turns the findings the user selected into a PR review: findings that hit
 * a line in the diff become inline comments (multi-line when their range
 * allows), the rest are listed in the review body with their location. The
 * user's own hunk comments go without a severity and title.
 */
export function buildReviewPayload(
  findings: readonly PostedFinding[],
  { diff, commitId, summary, event = "COMMENT" }: ReviewPayloadOptions,
): ReviewPayload {
  const lines = commentableLines(diff);
  const comments: ReviewCommentPayload[] = [];
  const general: string[] = [];
  for (const finding of findings) {
    const placed = place(finding, lines);
    if (placed) {
      comments.push({ ...placed, body: renderFindingComment(finding) });
    } else if (isUserComment(finding)) {
      const where = location(finding);
      general.push(`-${where}${where ? ":" : ""} ${finding.explanation.trim()}`);
    } else {
      general.push(
        `- **[${finding.severity}] ${finding.title}**${location(finding)}: ${finding.explanation.trim()}`,
      );
    }
  }
  const body = [
    summary?.trim() ?? "",
    general.length > 0
      ? `${comments.length > 0 ? "Findings outside the diff" : "Findings"}:\n\n${general.join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(commitId ? { commit_id: commitId } : {}),
    event,
    body:
      body ||
      (comments.length > 0
        ? `${comments.length} finding${comments.length === 1 ? "" : "s"}.`
        : "No findings."),
    comments,
  };
}
