import type { Fetch } from "../connection-test.js";
import type { AttachmentLimits } from "../jira/attachments.js";
import { JiraError, type JiraCredentials } from "../jira/client.js";
import { informFromJira, type JiraInformResult } from "../jira/inform.js";
import {
  createGitHubClient,
  type GitHubCredentials,
  type PullRequestCoordinates,
} from "./client.js";
import {
  fetchPullRequest,
  findJiraKey,
  renderPullRequest,
  type PullRequestContext,
} from "./pull-request.js";

export interface PullRequestInformOptions {
  /**
   * Jira site for a key found in the head branch or title. Without one the
   * key is only mentioned; a key that matches no issue is ignored.
   */
  jira?: JiraCredentials;
  /** Worktree the Jira issue's attachments are downloaded into. */
  worktreePath?: string;
  limits?: AttachmentLimits;
  maxDiffChars?: number;
  signal?: AbortSignal;
  fetch?: Fetch;
}

export interface PullRequestInformResult {
  pullRequest: PullRequestContext;
  /** Jira key found in the head branch or title. */
  jiraKey?: string;
  /** The linked issue, when a key and a Jira connection exist and the issue does. */
  jira?: JiraInformResult;
  /** The PR (and linked issue) as markdown for the Inform prompt. */
  markdown: string;
}

/**
 * Inform for a PR task: the PR description, diff, inline review comments
 * and conversation, plus the linked Jira issue when the branch or title
 * names one and a Jira connection is given.
 */
export async function informFromPullRequest(
  credentials: GitHubCredentials,
  pr: PullRequestCoordinates,
  {
    jira: jiraCredentials,
    worktreePath,
    limits,
    maxDiffChars,
    signal,
    fetch: fetchImpl,
  }: PullRequestInformOptions = {},
): Promise<PullRequestInformResult> {
  const client = createGitHubClient(credentials, fetchImpl);
  const pullRequest = await fetchPullRequest(client, pr, signal);
  const jiraKey = findJiraKey(pullRequest.headRef, pullRequest.title);

  let jira: JiraInformResult | undefined;
  let jiraNote = "";
  if (jiraKey && jiraCredentials) {
    try {
      jira = await informFromJira(jiraCredentials, jiraKey, {
        ...(worktreePath ? { worktreePath } : {}),
        ...(limits ? { limits } : {}),
        ...(signal ? { signal } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
    } catch (error) {
      // A key-shaped branch segment need not be an issue (`deps/lodash-4.17`).
      if (!(error instanceof JiraError && error.status === 404)) throw error;
    }
  } else if (jiraKey) {
    jiraNote = `The PR refers to Jira issue ${jiraKey}; no Jira connection is set up, so it is not included.`;
  }

  const markdown = [
    renderPullRequest(pullRequest, maxDiffChars !== undefined ? { maxDiffChars } : {}),
    jira?.markdown ?? jiraNote,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { pullRequest, ...(jiraKey ? { jiraKey } : {}), ...(jira ? { jira } : {}), markdown };
}
