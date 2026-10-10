import type { Fetch } from "../connection-test.js";
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubCredentials,
  type GitHubIssueCommentJson,
  type GitHubIssueJson,
  type PullRequestCoordinates,
} from "./client.js";
import { author, byCreated, day, demote, sectionOf } from "./markdown.js";

/** A comment in the issue's conversation. */
export interface IssueConversationItem {
  author: string;
  body: string;
  created: string | null;
}

/** Everything Inform needs from a GitHub issue, flattened from the REST payloads. */
export interface IssueContext {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  description: string;
  state: string;
  author: string | null;
  labels: string[];
  conversation: IssueConversationItem[];
}

export interface IssuePayloads {
  issue: GitHubIssueJson;
  comments: readonly GitHubIssueCommentJson[];
}

/** The label names of an issue; GitHub sends them as objects or, rarely, plain strings. */
export function issueLabels(issue: Pick<GitHubIssueJson, "labels">): string[] {
  return (issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter(Boolean);
}

/**
 * Refuses an issue link that is really a pull request: GitHub's issues API
 * answers for PRs too, and those belong to the PR origin.
 */
export function assertNotPullRequest(
  issue: Pick<GitHubIssueJson, "pull_request">,
  { owner, repo, number }: PullRequestCoordinates,
): void {
  if (issue.pull_request) {
    throw new Error(`${owner}/${repo}#${number} is a pull request; use the GitHub PR origin`);
  }
}

/** Builds the context from the recorded REST payloads (pure, so it is fixture-testable). */
export function assembleIssue(
  ref: PullRequestCoordinates,
  { issue, comments }: IssuePayloads,
): IssueContext {
  const conversation = comments
    .map((c) => ({
      author: author(c.user),
      body: (c.body ?? "").trim(),
      created: c.created_at ?? null,
    }))
    .filter((item) => item.body !== "")
    .sort(byCreated);
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    description: (issue.body ?? "").trim(),
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: issueLabels(issue),
    conversation,
  };
}

/** Fetches the issue and its conversation; refuses a pull request. */
export async function fetchIssue(
  client: GitHubClient,
  ref: PullRequestCoordinates,
  signal?: AbortSignal,
): Promise<IssueContext> {
  const [issue, comments] = await Promise.all([
    client.getIssue(ref, signal),
    client.listIssueComments(ref, signal),
  ]);
  assertNotPullRequest(issue, ref);
  return assembleIssue(ref, { issue, comments });
}

/** The issue as markdown for the Inform prompt. */
export function renderIssue(issue: IssueContext): string {
  const facts = [
    `State: ${issue.state}`,
    issue.author ? `Author: ${issue.author}` : "",
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : "",
  ].filter(Boolean);

  const conversation = issue.conversation
    .map((c) => `**${c.author}**${day(c.created)}:\n\n${demote(c.body, 4)}`)
    .join("\n\n---\n\n");

  return [
    `## Issue ${issue.owner}/${issue.repo}#${issue.number}: ${issue.title}`,
    `${facts.join(" · ")}\n${issue.url}`,
    sectionOf("Description", demote(issue.description, 4)),
    sectionOf("Conversation", conversation),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface IssueInformOptions {
  signal?: AbortSignal;
  fetch?: Fetch;
}

export interface IssueInformResult {
  issue: IssueContext;
  /** The issue as markdown for the Inform prompt. */
  markdown: string;
}

/** Inform for a GitHub issue task: the issue's description and conversation. */
export async function informFromIssue(
  credentials: GitHubCredentials,
  ref: PullRequestCoordinates,
  { signal, fetch: fetchImpl }: IssueInformOptions = {},
): Promise<IssueInformResult> {
  const issue = await fetchIssue(createGitHubClient(credentials, fetchImpl), ref, signal);
  return { issue, markdown: renderIssue(issue) };
}
