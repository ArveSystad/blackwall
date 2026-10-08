import type { Fetch } from "../connection-test.js";
import { downloadJiraAttachments, type AttachmentLimits } from "./attachments.js";
import { createJiraClient, type JiraCredentials } from "./client.js";
import {
  fetchJiraIssue,
  renderJiraIssue,
  type AttachmentOutcome,
  type JiraIssueContext,
} from "./issue.js";

export interface JiraInformOptions {
  /** Worktree the attachments are downloaded into; without one they are only listed. */
  worktreePath?: string;
  limits?: AttachmentLimits;
  signal?: AbortSignal;
  fetch?: Fetch;
}

export interface JiraInformResult {
  issue: JiraIssueContext;
  attachments: AttachmentOutcome[];
  /** The issue as markdown for the Inform prompt. */
  markdown: string;
}

/**
 * Inform for a Jira task: fetches the issue (comments, links, parent,
 * sub-tasks), downloads its supported attachments into the worktree's
 * scratch folder and renders it all as agent context.
 */
export async function informFromJira(
  credentials: JiraCredentials,
  key: string,
  { worktreePath, limits, signal, fetch: fetchImpl }: JiraInformOptions = {},
): Promise<JiraInformResult> {
  const client = createJiraClient(credentials, fetchImpl);
  const issue = await fetchJiraIssue(client, key, signal);
  const attachments = worktreePath
    ? await downloadJiraAttachments(client, issue.key, issue.attachments, {
        worktreePath,
        ...(limits ? { limits } : {}),
        ...(signal ? { signal } : {}),
      })
    : [];
  return { issue, attachments, markdown: renderJiraIssue(issue, attachments) };
}
