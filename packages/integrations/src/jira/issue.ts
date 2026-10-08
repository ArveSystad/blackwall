import { adfToMarkdown } from "./adf.js";
import type {
  JiraAttachmentJson,
  JiraClient,
  JiraCommentJson,
  JiraIssueJson,
  JiraIssueSummaryJson,
  JiraUserJson,
} from "./client.js";

/** Another issue as context shows it: parent, sub-task or linked issue. */
export interface JiraRelatedIssue {
  key: string;
  summary: string;
  type: string;
  status: string;
}

export interface JiraLinkedIssue extends JiraRelatedIssue {
  /** How this issue relates to the linked one, e.g. "blocks" or "is blocked by". */
  relation: string;
}

export interface JiraComment {
  author: string;
  created: string;
  /** Markdown, converted from ADF. */
  body: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Everything Inform knows about a Jira issue, with ADF already converted to markdown. */
export interface JiraIssueContext {
  key: string;
  url: string;
  summary: string;
  type: string;
  status: string;
  priority: string | null;
  labels: string[];
  reporter: string | null;
  assignee: string | null;
  description: string;
  parent: (JiraRelatedIssue & { description: string }) | null;
  subtasks: JiraRelatedIssue[];
  links: JiraLinkedIssue[];
  comments: JiraComment[];
  attachments: JiraAttachment[];
}

function userName(user: JiraUserJson | null | undefined): string | null {
  return user?.displayName ?? user?.emailAddress ?? null;
}

function related(issue: JiraIssueSummaryJson): JiraRelatedIssue {
  return {
    key: issue.key,
    summary: issue.fields?.summary ?? "",
    type: issue.fields?.issuetype?.name ?? "Issue",
    status: issue.fields?.status?.name ?? "Unknown",
  };
}

function comment(c: JiraCommentJson): JiraComment {
  return {
    author: userName(c.author) ?? "Unknown",
    created: c.created ?? "",
    body: adfToMarkdown(c.body),
  };
}

function attachment(a: JiraAttachmentJson): JiraAttachment {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType ?? "application/octet-stream",
    size: a.size ?? 0,
  };
}

export interface AssembleOptions {
  /** Browser link to the issue. */
  url: string;
  /** All comments when the issue's embedded list is truncated; defaults to the embedded ones. */
  comments?: readonly JiraCommentJson[];
  /** The parent fetched on its own, for its description; defaults to the embedded parent. */
  parent?: JiraIssueSummaryJson;
}

/** Builds the issue context from Jira's JSON (pure; see {@link fetchJiraIssue} for the requests). */
export function assembleJiraIssue(
  issue: JiraIssueJson,
  options: AssembleOptions,
): JiraIssueContext {
  const f = issue.fields;
  const parent = options.parent ?? f.parent;
  return {
    key: issue.key,
    url: options.url,
    summary: f.summary ?? "",
    type: f.issuetype?.name ?? "Issue",
    status: f.status?.name ?? "Unknown",
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    reporter: userName(f.reporter),
    assignee: userName(f.assignee),
    description: adfToMarkdown(f.description),
    parent: parent
      ? { ...related(parent), description: adfToMarkdown(parent.fields?.description) }
      : null,
    subtasks: (f.subtasks ?? []).map(related),
    links: (f.issuelinks ?? []).flatMap((link): JiraLinkedIssue[] => {
      if (link.outwardIssue) {
        const relation = link.type?.outward ?? link.type?.name ?? "relates to";
        return [{ ...related(link.outwardIssue), relation }];
      }
      if (link.inwardIssue) {
        const relation = link.type?.inward ?? link.type?.name ?? "relates to";
        return [{ ...related(link.inwardIssue), relation }];
      }
      return [];
    }),
    comments: (options.comments ?? f.comment?.comments ?? []).map(comment),
    attachments: (f.attachment ?? []).map(attachment),
  };
}

/**
 * Fetches an issue with all its comments and its parent's description, and
 * assembles the context. The parent is optional context: a parent the
 * account cannot read falls back to the summary embedded in the issue.
 */
export async function fetchJiraIssue(
  client: Pick<JiraClient, "getIssue" | "getIssueSummary" | "getComments" | "browseUrl">,
  key: string,
  signal?: AbortSignal,
): Promise<JiraIssueContext> {
  const issue = await client.getIssue(key, signal);
  const embedded = issue.fields.comment;
  const truncated = (embedded?.total ?? 0) > (embedded?.comments?.length ?? 0);
  const [comments, parent] = await Promise.all([
    truncated ? client.getComments(issue.key, signal) : undefined,
    issue.fields.parent
      ? client.getIssueSummary(issue.fields.parent.key, signal).catch(() => undefined)
      : undefined,
  ]);
  return assembleJiraIssue(issue, {
    url: client.browseUrl(issue.key),
    ...(comments ? { comments } : {}),
    ...(parent ? { parent } : {}),
  });
}

/** What happened to one attachment: saved into the worktree, or skipped and why. */
export type AttachmentOutcome =
  | { attachment: JiraAttachment; saved: true; path: string }
  | { attachment: JiraAttachment; saved: false; reason: string };

function describeRelated(issue: JiraRelatedIssue): string {
  return `${issue.key} (${issue.type}, ${issue.status}): ${issue.summary}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shifts markdown headings down so they nest under the context's own sections. */
function demote(markdown: string, by: number): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (h) => "#".repeat(Math.min(h.length + by, 6)));
    })
    .join("\n");
}

function sectionOf(title: string, body: string): string {
  return body.trim() ? `### ${title}\n\n${body.trim()}` : "";
}

/**
 * Renders the issue context as markdown for an agent prompt. Pass the
 * attachment outcomes to list where the downloaded files are in the worktree.
 */
export function renderJiraIssue(
  issue: JiraIssueContext,
  attachments: readonly AttachmentOutcome[] = [],
): string {
  const facts = [
    `Type: ${issue.type}`,
    `Status: ${issue.status}`,
    issue.priority ? `Priority: ${issue.priority}` : "",
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
    issue.reporter ? `Reporter: ${issue.reporter}` : "",
    issue.assignee ? `Assignee: ${issue.assignee}` : "",
  ].filter(Boolean);

  const parent = issue.parent
    ? [describeRelated(issue.parent), demote(issue.parent.description, 3)]
        .filter(Boolean)
        .join("\n\n")
    : "";

  const comments = issue.comments
    .map(
      (c) =>
        `**${c.author}**${c.created ? ` (${c.created.slice(0, 10)})` : ""}:\n\n${demote(c.body, 3)}`,
    )
    .join("\n\n---\n\n");

  const saved = attachments.filter((a) => a.saved);
  const skipped = attachments.filter((a) => !a.saved);
  const files = [
    saved.length > 0
      ? `Downloaded into the worktree:\n\n${saved
          .map(
            (a) => `- \`${a.path}\` (${a.attachment.mimeType}, ${formatSize(a.attachment.size)})`,
          )
          .join("\n")}`
      : "",
    skipped.length > 0
      ? `Not downloaded:\n\n${skipped
          .map((a) => `- ${a.attachment.filename} (${a.attachment.mimeType}): ${a.reason}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    `## Jira issue ${issue.key}: ${issue.summary}`,
    `${facts.join(" · ")}\n${issue.url}`,
    sectionOf("Description", demote(issue.description, 3)),
    sectionOf("Parent", parent),
    sectionOf("Sub-tasks", issue.subtasks.map((s) => `- ${describeRelated(s)}`).join("\n")),
    sectionOf(
      "Linked issues",
      issue.links.map((l) => `- ${l.relation} ${describeRelated(l)}`).join("\n"),
    ),
    sectionOf("Comments", comments),
    sectionOf("Attachments", files),
  ]
    .filter(Boolean)
    .join("\n\n");
}
