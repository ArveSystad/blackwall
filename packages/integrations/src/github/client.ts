import { Octokit } from "@octokit/rest";
import { githubApiUrl, githubFailureReason, type Fetch } from "../connection-test.js";
import type { ReviewPayload } from "./review.js";

/** A GitHub.com or GHE host and a personal access token for it. */
export interface GitHubCredentials {
  /** Web URL of the host (`https://github.com`, `https://acme.ghe.com`); the API root is derived. */
  baseUrl: string;
  token: string;
}

/**
 * Why GitHub refused a request, when the response says: a primary or
 * secondary rate limit, or a token not authorised for the org's SAML SSO.
 */
export type GitHubErrorCause = "rate-limited" | "sso";

/** A failed GitHub request. The message never contains the token. */
export class GitHubError extends Error {
  constructor(
    message: string,
    /** HTTP status; undefined when the request never got a response. */
    readonly status?: number,
    override readonly cause?: GitHubErrorCause,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubUserJson {
  login: string;
}

/** A PR's head or base repository. */
export interface GitHubRepoRefJson {
  full_name: string;
  default_branch?: string;
}

/** `GET /repos/{owner}/{repo}/pulls/{n}`, the fields Inform and delivery read. */
export interface GitHubPullRequestJson {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  merged?: boolean;
  user?: GitHubUserJson | null;
  labels?: { name?: string }[];
  head: { ref: string; sha: string; repo?: GitHubRepoRefJson | null };
  base: { ref: string; sha: string; repo?: GitHubRepoRefJson | null };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

/** `GET /repos/{owner}/{repo}/issues/{n}`, the fields Inform and branch naming read. */
export interface GitHubIssueJson {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  user?: GitHubUserJson | null;
  labels?: (string | { name?: string })[];
  /** Set when the "issue" is a pull request; the issues API returns those too. */
  pull_request?: unknown;
}

/** An inline review comment (`GET /pulls/{n}/comments`). */
export interface GitHubReviewCommentJson {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  side?: string | null;
  body: string;
  user?: GitHubUserJson | null;
  created_at?: string;
  in_reply_to_id?: number;
  diff_hunk?: string;
  html_url?: string;
}

/** A conversation comment on a PR or issue (`GET /issues/{n}/comments`). */
export interface GitHubIssueCommentJson {
  id: number;
  body?: string | null;
  user?: GitHubUserJson | null;
  created_at?: string;
}

/** A submitted review (`GET /pulls/{n}/reviews`). */
export interface GitHubReviewJson {
  id: number;
  state: string;
  body?: string | null;
  user?: GitHubUserJson | null;
  submitted_at?: string;
}

/** A commit of a pull request (`GET /pulls/{n}/commits`), with the GitHub user it is linked to. */
export interface GitHubPullRequestCommitJson {
  sha: string;
  author?: GitHubUserJson | null;
}

/** A commit on a pull request; `authorLogin` is null when the commit's author email is not linked to a GitHub user. */
export interface PullRequestCommit {
  sha: string;
  authorLogin: string | null;
}

/** A check run on a commit (`GET /commits/{ref}/check-runs`), the fields CI reads. */
export interface GitHubCheckRunJson {
  id: number;
  name: string;
  /** `queued`, `in_progress`, `completed`, … */
  status: string;
  /** Set once completed: `success`, `failure`, `neutral`, `skipped`, `timed_out`, … */
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null; text?: string | null } | null;
}

/** A commit status (`GET /commits/{ref}/status`'s `statuses`). */
export interface GitHubCommitStatusJson {
  id: number;
  context: string;
  /** `pending`, `success`, `failure` or `error`. */
  state: string;
  description?: string | null;
  target_url?: string | null;
}

/** `GET /repos/{owner}/{repo}/commits/{ref}/status`. */
export interface GitHubCombinedStatusJson {
  /** `pending` also when there are no statuses at all; read `statuses` instead. */
  state: string;
  sha: string;
  statuses: GitHubCommitStatusJson[];
}

/** A commit in a repository. */
export interface CommitCoordinates {
  owner: string;
  repo: string;
  /** Commit sha, branch or tag. */
  ref: string;
}

export interface NewPullRequest {
  owner: string;
  repo: string;
  /** Branch with the changes. */
  head: string;
  /** Branch to merge into. */
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
}

/** Input for {@link createGitHubClient}'s `createIssue`. */
export interface NewIssue {
  owner: string;
  repo: string;
  title: string;
  body: string;
}

/** Filters for {@link createGitHubClient}'s `listOpenPullRequests`. */
export interface OpenPullRequestsQuery {
  owner: string;
  repo: string;
  /** Only PRs from this head, as `owner:branch`. */
  head?: string;
  /** Only PRs into this base branch. */
  base?: string;
}

export interface PullRequestCoordinates {
  owner: string;
  repo: string;
  number: number;
}

/**
 * An open pull request waiting on the user's review, as
 * {@link createGitHubClient}'s `searchReviewRequests` returns it.
 */
export interface GitHubReviewRequest {
  /** The connection's host (`github.com`, `acme.ghe.com`). */
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  /** ISO 8601. */
  updatedAt: string;
  reviewDecision: "review-required" | "changes-requested" | null;
}

/** A `PullRequest` node of the review requests search. */
interface ReviewRequestNode {
  url?: string;
  number?: number;
  title?: string;
  updatedAt?: string;
  isDraft?: boolean;
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  author?: { login: string } | null;
  repository?: { name: string; owner: { login: string } };
}

/**
 * Open, non-draft PRs whose review is requested from the user or one of their
 * teams (`review-requested:@me` matches both), and that nobody has approved.
 */
const REVIEW_REQUESTS_SEARCH =
  "is:pr is:open archived:false draft:false review-requested:@me -review:approved";

const REVIEW_REQUESTS_QUERY = `query ReviewRequests($search: String!) {
  search(type: ISSUE, query: $search, first: 100) {
    nodes {
      ... on PullRequest {
        url
        number
        title
        updatedAt
        isDraft
        reviewDecision
        author { login }
        repository { name owner { login } }
      }
    }
  }
}`;

const REVIEW_DECISIONS = {
  REVIEW_REQUIRED: "review-required",
  CHANGES_REQUESTED: "changes-requested",
} as const;

/** GitHub's review decision on a PR the user wrote, approved included. */
export type AuthoredReviewDecision = "approved" | "review-required" | "changes-requested";

const AUTHORED_REVIEW_DECISIONS = {
  ...REVIEW_DECISIONS,
  APPROVED: "approved",
} as const;

/** The combined state of a commit's checks and statuses. */
export type ChecksRollup = "pending" | "passed" | "failed";

const CHECK_ROLLUPS: Record<string, ChecksRollup> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  PENDING: "pending",
  EXPECTED: "pending",
};

/** A merge strategy GitHub offers on a pull request. */
export type GitHubMergeMethod = "merge" | "squash" | "rebase";

/**
 * An open pull request the user wrote, as {@link createGitHubClient}'s
 * `searchAuthoredPullRequests` returns it.
 */
export interface GitHubAuthoredPullRequest {
  /** The connection's host (`github.com`, `acme.ghe.com`). */
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** ISO 8601. */
  updatedAt: string;
  draft: boolean;
  reviewDecision: AuthoredReviewDecision | null;
  /** Each writer's latest approval or change request. */
  reviewers: GitHubPullRequestReviewer[];
  /** The head commit's checks; null when it has none GitHub can roll up. */
  checks: ChecksRollup | null;
  /**
   * Newest review or comment by someone other than the author and not a bot,
   * ISO 8601; null when there is none among the last ten of each.
   */
  activityAt: string | null;
  headSha: string;
}

/**
 * Someone whose latest opinionated review approved the pull request or asked
 * for changes; `name` is their GitHub display name, null when unset.
 */
export interface GitHubPullRequestReviewer {
  login: string;
  name: string | null;
  state: "approved" | "changes-requested";
}

/** The author of a comment or review; `__typename` tells bots apart. */
interface ActivityAuthor {
  __typename?: string;
  login: string;
}

/** `latestOpinionatedReviews` as both pull request queries select it. */
interface OpinionatedReviews {
  nodes?: ({ state?: string; author?: { login: string; name?: string | null } | null } | null)[];
}

/** The selection {@link opinionatedReviewers} reads. */
const OPINIONATED_REVIEWS_SELECTION =
  "latestOpinionatedReviews(first: 20, writersOnly: true) { nodes { state author { login ... on User { name } } } }";

/**
 * The reviewers who approved or asked for changes, dropping reviews whose
 * author is gone and any other state (dismissed, commented).
 */
function opinionatedReviewers(
  reviews: OpinionatedReviews | null | undefined,
): GitHubPullRequestReviewer[] {
  return (reviews?.nodes ?? []).flatMap((node): GitHubPullRequestReviewer[] => {
    if (!node?.author) return [];
    const state =
      node.state === "APPROVED"
        ? "approved"
        : node.state === "CHANGES_REQUESTED"
          ? "changes-requested"
          : null;
    if (!state) return [];
    return [{ login: node.author.login, name: node.author.name || null, state }];
  });
}

/** A `PullRequest` node of the authored pull requests search. */
interface AuthoredPullRequestNode {
  url?: string;
  number?: number;
  title?: string;
  updatedAt?: string;
  isDraft?: boolean;
  reviewDecision?: keyof typeof AUTHORED_REVIEW_DECISIONS | null;
  headRefOid?: string;
  author?: { login: string } | null;
  repository?: { name: string; owner: { login: string } };
  commits?: {
    nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null)[];
  } | null;
  comments?: { nodes?: ({ createdAt?: string; author?: ActivityAuthor | null } | null)[] } | null;
  reviews?: {
    nodes?: ({ submittedAt?: string | null; author?: ActivityAuthor | null } | null)[];
  } | null;
  latestOpinionatedReviews?: OpinionatedReviews | null;
}

/** Open PRs the user wrote outside archived repos, drafts and approved ones included. */
const AUTHORED_PRS_SEARCH = "is:pr is:open archived:false author:@me";

const AUTHORED_PRS_QUERY = `query AuthoredPullRequests($search: String!) {
  search(type: ISSUE, query: $search, first: 100) {
    nodes {
      ... on PullRequest {
        url
        number
        title
        updatedAt
        isDraft
        reviewDecision
        headRefOid
        author { login }
        repository { name owner { login } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        comments(last: 10) { nodes { createdAt author { __typename login } } }
        reviews(last: 10) { nodes { submittedAt author { __typename login } } }
        ${OPINIONATED_REVIEWS_SELECTION}
      }
    }
  }
}`;

const PULL_REQUEST_STATUS_QUERY = `query PullRequestStatus($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      mergeable
      ${OPINIONATED_REVIEWS_SELECTION}
    }
  }
}`;

/**
 * The newest time among comments and reviews by someone other than `author`
 * and not a bot; an item whose author is gone counts.
 */
function latestActivity(
  author: string | null,
  items: readonly { at: string | null | undefined; by: ActivityAuthor | null | undefined }[],
): string | null {
  let latest: string | null = null;
  for (const { at, by } of items) {
    if (!at) continue;
    if (by && (by.__typename === "Bot" || (author !== null && by.login === author))) continue;
    if (latest === null || Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}

/**
 * An open issue assigned to the user, as {@link createGitHubClient}'s
 * `searchAssignedIssues` returns it.
 */
export interface GitHubAssignedIssue {
  /** The connection's host (`github.com`, `acme.ghe.com`). */
  host: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  /** ISO 8601. */
  updatedAt: string;
}

/** An `Issue` node of the assigned issues search. */
interface AssignedIssueNode {
  url?: string;
  number?: number;
  title?: string;
  updatedAt?: string;
  author?: { login: string } | null;
  repository?: { name: string; owner: { login: string } };
}

/** Open issues assigned to the user, outside archived repos. */
const ASSIGNED_ISSUES_SEARCH = "is:issue is:open archived:false assignee:@me";

const ASSIGNED_ISSUES_QUERY = `query AssignedIssues($search: String!) {
  search(type: ISSUE, query: $search, first: 100) {
    nodes {
      ... on Issue {
        url
        number
        title
        updatedAt
        author { login }
        repository { name owner { login } }
      }
    }
  }
}`;

/** An open issue in one repository, whoever it is assigned to. */
export interface GitHubRepoIssue extends GitHubAssignedIssue {
  /** Logins of the issue's assignees (at most 10). */
  assignees: string[];
}

/** An `Issue` node of the repository issues search. */
interface RepoIssueNode extends AssignedIssueNode {
  assignees?: { nodes?: ({ login: string } | null)[] } | null;
}

const REPO_ISSUES_QUERY = `query RepoIssues($search: String!) {
  search(type: ISSUE, query: $search, first: 100) {
    nodes {
      ... on Issue {
        url
        number
        title
        updatedAt
        author { login }
        repository { name owner { login } }
        assignees(first: 10) { nodes { login } }
      }
    }
  }
}`;

const TIMEOUT_MS = 30_000;
const PER_PAGE = 100;

export type GitHubClient = ReturnType<typeof createGitHubClient>;

/** HTTP status of a response GitHub sent; undefined when the request never got one. */
function statusOf(error: unknown): number | undefined {
  // Octokit reports network failures as status 500 without a response.
  const { status, response } = (error ?? {}) as { status?: unknown; response?: unknown };
  return response !== undefined && typeof status === "number" ? status : undefined;
}

/** A response header from Octokit's lower-cased header object. */
function headerOf(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  return value === null || value === undefined ? undefined : String(value);
}

/** Whether a refusal is a rate limit or a missing SAML SSO authorisation. */
function causeOf(
  status: number,
  headers: Record<string, unknown> | undefined,
): GitHubErrorCause | undefined {
  if (status !== 403 && status !== 429) return undefined;
  if (
    headerOf(headers, "x-ratelimit-remaining") === "0" ||
    headerOf(headers, "retry-after") !== undefined
  ) {
    return "rate-limited";
  }
  if (status === 403 && headerOf(headers, "x-github-sso") !== undefined) return "sso";
  return undefined;
}

/** The errors of a GraphQL response GitHub answered with 200; Octokit throws those without a status. */
function graphqlErrors(error: unknown): { message?: unknown }[] | undefined {
  const { name, errors } = (error ?? {}) as { name?: unknown; errors?: unknown };
  return name === "GraphqlResponseError" && Array.isArray(errors) && errors.length > 0
    ? (errors as { message?: unknown }[])
    : undefined;
}

/**
 * GitHub/GHE REST client on Octokit. The API root comes from the
 * connection's base URL (api.github.com, `api.<sub>.ghe.com` on GHE.com, or
 * `/api/v3` on GHE Server), so the token only goes to that host. Errors become {@link GitHubError}s that never
 * echo the request or its headers.
 */
export function createGitHubClient(credentials: GitHubCredentials, fetchImpl: Fetch = fetch) {
  const apiUrl = githubApiUrl(credentials.baseUrl);
  const host = new URL(credentials.baseUrl).host.toLowerCase();
  const octokit = new Octokit({
    auth: credentials.token,
    baseUrl: apiUrl,
    userAgent: "blackwall",
    request: { fetch: fetchImpl },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });

  function failure(error: unknown, what: string): GitHubError {
    const errors = graphqlErrors(error);
    if (errors) {
      const message = typeof errors[0]?.message === "string" ? errors[0].message : "";
      const reason = message.replaceAll(credentials.token, "***").trim() || "query failed";
      return new GitHubError(`${host}: ${reason}`);
    }
    const status = statusOf(error);
    if (status === undefined) {
      const timedOut =
        error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`);
      return new GitHubError(`${host}: ${timedOut ? "timed out" : "could not connect"}`);
    }
    const { response } = error as {
      response?: { headers?: Record<string, unknown>; data?: unknown };
    };
    const data = response?.data;
    const reason =
      status === 404
        ? `${what} not found (or not visible to this token)`
        : status === 422
          ? `${what} rejected by GitHub (validation failed)`
          : githubFailureReason(status, {
              headers: response?.headers,
              message:
                data && typeof data === "object"
                  ? (data as { message?: unknown }).message
                  : undefined,
              token: credentials.token,
            });
    return new GitHubError(`${host}: ${reason}`, status, causeOf(status, response?.headers));
  }

  function requestOptions(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    return { signal: signal ? AbortSignal.any([timeout, signal]) : timeout };
  }

  async function call<T>(what: string, signal: AbortSignal | undefined, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted || error instanceof GitHubError) throw error;
      throw failure(error, what);
    }
  }

  const prName = ({ owner, repo, number }: PullRequestCoordinates) => `${owner}/${repo}#${number}`;
  const commitName = ({ owner, repo, ref }: CommitCoordinates) => `${owner}/${repo}@${ref}`;

  return {
    apiUrl,

    /** The pull request's metadata. */
    getPullRequest(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const res = await octokit.rest.pulls.get({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          request: requestOptions(signal),
        });
        return res.data as unknown as GitHubPullRequestJson;
      });
    },

    /** The issue's metadata; a pull request also answers here, with `pull_request` set. */
    getIssue(issue: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(issue), signal, async () => {
        const res = await octokit.rest.issues.get({
          owner: issue.owner,
          repo: issue.repo,
          issue_number: issue.number,
          request: requestOptions(signal),
        });
        return res.data as unknown as GitHubIssueJson;
      });
    },

    /** The pull request's unified diff against its base. */
    getPullRequestDiff(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const res = await octokit.rest.pulls.get({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          mediaType: { format: "diff" },
          request: requestOptions(signal),
        });
        return res.data as unknown as string;
      });
    },

    /** The repository's open pull requests, optionally only those from `head` or into `base`. */
    listOpenPullRequests(query: OpenPullRequestsQuery, signal?: AbortSignal) {
      return call(`${query.owner}/${query.repo}`, signal, async () => {
        const all = await octokit.paginate(octokit.rest.pulls.list, {
          owner: query.owner,
          repo: query.repo,
          state: "open",
          ...(query.head !== undefined ? { head: query.head } : {}),
          ...(query.base !== undefined ? { base: query.base } : {}),
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return all as unknown as GitHubPullRequestJson[];
      });
    },

    /** Every inline review comment, oldest first. */
    listReviewComments(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const all = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return all as unknown as GitHubReviewCommentJson[];
      });
    },

    /** Every conversation comment, oldest first. */
    listIssueComments(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const all = await octokit.paginate(octokit.rest.issues.listComments, {
          owner: pr.owner,
          repo: pr.repo,
          issue_number: pr.number,
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return all as unknown as GitHubIssueCommentJson[];
      });
    },

    /** Every submitted review (approve / request changes / comment), oldest first. */
    listReviews(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const all = await octokit.paginate(octokit.rest.pulls.listReviews, {
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return all as unknown as GitHubReviewJson[];
      });
    },

    /** Every commit on the pull request, oldest first. */
    listPullRequestCommits(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const all = await octokit.paginate(octokit.rest.pulls.listCommits, {
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return (all as unknown as GitHubPullRequestCommitJson[]).map(
          (commit): PullRequestCommit => ({
            sha: commit.sha,
            authorLogin: commit.author?.login ?? null,
          }),
        );
      });
    },

    /** Opens a pull request; returns its number and link. */
    createPullRequest(input: NewPullRequest) {
      return call(
        `Pull request ${input.owner}/${input.repo} ${input.head}`,
        undefined,
        async () => {
          const res = await octokit.rest.pulls.create({
            owner: input.owner,
            repo: input.repo,
            head: input.head,
            base: input.base,
            title: input.title,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.draft !== undefined ? { draft: input.draft } : {}),
            request: requestOptions(),
          });
          return { number: res.data.number, url: res.data.html_url };
        },
      );
    },

    /** Opens an issue; returns its number and link. */
    createIssue(input: NewIssue) {
      return call(`Issue ${input.owner}/${input.repo}`, undefined, async () => {
        const res = await octokit.rest.issues.create({
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          body: input.body,
          request: requestOptions(),
        });
        return { number: res.data.number, url: res.data.html_url };
      });
    },

    /** Posts a conversation comment on the pull request or issue. */
    addComment(pr: PullRequestCoordinates, body: string) {
      return call(prName(pr), undefined, async () => {
        const res = await octokit.rest.issues.createComment({
          owner: pr.owner,
          repo: pr.repo,
          issue_number: pr.number,
          body,
          request: requestOptions(),
        });
        return { id: res.data.id, url: res.data.html_url };
      });
    },

    /**
     * Open PRs on this host waiting on the user's review (see
     * {@link REVIEW_REQUESTS_SEARCH}), at most 100, as GitHub's search orders them.
     */
    searchReviewRequests(signal?: AbortSignal) {
      return call("Review requests", signal, async () => {
        const res = await octokit.graphql<{ search: { nodes: ReviewRequestNode[] } }>(
          REVIEW_REQUESTS_QUERY,
          { search: REVIEW_REQUESTS_SEARCH, request: requestOptions(signal) },
        );
        return res.search.nodes.flatMap((node): GitHubReviewRequest[] => {
          if (!node.url || !node.repository || node.number === undefined) return [];
          if (node.isDraft || node.reviewDecision === "APPROVED") return [];
          return [
            {
              host,
              owner: node.repository.owner.login,
              repo: node.repository.name,
              number: node.number,
              title: node.title ?? "",
              url: node.url,
              author: node.author?.login ?? null,
              updatedAt: node.updatedAt ?? new Date(0).toISOString(),
              reviewDecision: node.reviewDecision ? REVIEW_DECISIONS[node.reviewDecision] : null,
            },
          ];
        });
      });
    },

    /**
     * Open PRs on this host the user wrote (see {@link AUTHORED_PRS_SEARCH}),
     * at most 100, as GitHub's search orders them, with their head's checks
     * and the time of the last review or comment from someone else.
     */
    searchAuthoredPullRequests(signal?: AbortSignal) {
      return call("Your pull requests", signal, async () => {
        const res = await octokit.graphql<{ search: { nodes: AuthoredPullRequestNode[] } }>(
          AUTHORED_PRS_QUERY,
          { search: AUTHORED_PRS_SEARCH, request: requestOptions(signal) },
        );
        return res.search.nodes.flatMap((node): GitHubAuthoredPullRequest[] => {
          if (!node.url || !node.repository || node.number === undefined) return [];
          const author = node.author?.login ?? null;
          const rollup = node.commits?.nodes?.at(-1)?.commit?.statusCheckRollup?.state;
          return [
            {
              host,
              owner: node.repository.owner.login,
              repo: node.repository.name,
              number: node.number,
              title: node.title ?? "",
              url: node.url,
              updatedAt: node.updatedAt ?? new Date(0).toISOString(),
              draft: node.isDraft ?? false,
              reviewDecision: node.reviewDecision
                ? (AUTHORED_REVIEW_DECISIONS[node.reviewDecision] ?? null)
                : null,
              reviewers: opinionatedReviewers(node.latestOpinionatedReviews),
              checks: rollup ? (CHECK_ROLLUPS[rollup] ?? null) : null,
              activityAt: latestActivity(author, [
                ...(node.comments?.nodes ?? []).map((c) => ({ at: c?.createdAt, by: c?.author })),
                ...(node.reviews?.nodes ?? []).map((r) => ({ at: r?.submittedAt, by: r?.author })),
              ]),
              headSha: node.headRefOid ?? "",
            },
          ];
        });
      });
    },

    /**
     * The pull request's review decision and whether it merges cleanly;
     * `mergeable` is null while GitHub is still working it out.
     */
    getPullRequestStatus(pr: PullRequestCoordinates, signal?: AbortSignal) {
      return call(prName(pr), signal, async () => {
        const res = await octokit.graphql<{
          repository: {
            pullRequest: {
              reviewDecision?: keyof typeof AUTHORED_REVIEW_DECISIONS | null;
              mergeable?: string | null;
              latestOpinionatedReviews?: OpinionatedReviews | null;
            } | null;
          } | null;
        }>(PULL_REQUEST_STATUS_QUERY, {
          owner: pr.owner,
          name: pr.repo,
          number: pr.number,
          request: requestOptions(signal),
        });
        const node = res.repository?.pullRequest;
        if (!node) throw new GitHubError(`${host}: ${prName(pr)} not found`, 404);
        return {
          reviewDecision: node.reviewDecision
            ? ((AUTHORED_REVIEW_DECISIONS[node.reviewDecision] ??
                null) as AuthoredReviewDecision | null)
            : null,
          mergeable:
            node.mergeable === "MERGEABLE" ? true : node.mergeable === "CONFLICTING" ? false : null,
          reviewers: opinionatedReviewers(node.latestOpinionatedReviews),
        };
      });
    },

    /**
     * Merges the pull request with `method`, only if its head is still `sha`.
     * GitHub's refusal (405: not mergeable or method not allowed, 409: the head
     * moved) comes back as a {@link GitHubError} carrying GitHub's message.
     */
    mergePullRequest(
      pr: PullRequestCoordinates,
      { method, sha }: { method: GitHubMergeMethod; sha: string },
    ) {
      return call(prName(pr), undefined, async () => {
        try {
          const res = await octokit.rest.pulls.merge({
            owner: pr.owner,
            repo: pr.repo,
            pull_number: pr.number,
            merge_method: method,
            sha,
            request: requestOptions(),
          });
          return { sha: res.data.sha, merged: res.data.merged };
        } catch (error) {
          const status = statusOf(error);
          if (status !== 405 && status !== 409) throw error;
          const data = (error as { response?: { data?: unknown } }).response?.data;
          const message =
            data && typeof data === "object" ? (data as { message?: unknown }).message : undefined;
          const reason =
            typeof message === "string" && message.trim()
              ? message.replaceAll(credentials.token, "***").trim()
              : status === 409
                ? "the head branch moved; refresh and try again"
                : "GitHub refused the merge";
          throw new GitHubError(`${host}: ${reason}`, status);
        }
      });
    },

    /**
     * Open issues on this host assigned to the user (see
     * {@link ASSIGNED_ISSUES_SEARCH}), at most 100, as GitHub's search orders them.
     */
    searchAssignedIssues(signal?: AbortSignal) {
      return call("Assigned issues", signal, async () => {
        const res = await octokit.graphql<{ search: { nodes: AssignedIssueNode[] } }>(
          ASSIGNED_ISSUES_QUERY,
          { search: ASSIGNED_ISSUES_SEARCH, request: requestOptions(signal) },
        );
        return res.search.nodes.flatMap((node): GitHubAssignedIssue[] => {
          if (!node.url || !node.repository || node.number === undefined) return [];
          return [
            {
              host,
              owner: node.repository.owner.login,
              repo: node.repository.name,
              number: node.number,
              title: node.title ?? "",
              url: node.url,
              author: node.author?.login ?? null,
              updatedAt: node.updatedAt ?? new Date(0).toISOString(),
            },
          ];
        });
      });
    },

    /**
     * Open issues in the repository, whoever they are assigned to, at most
     * 100, most recently updated first.
     */
    searchRepoIssues(repository: { owner: string; repo: string }, signal?: AbortSignal) {
      const search = `repo:${repository.owner}/${repository.repo} is:issue is:open archived:false sort:updated-desc`;
      return call(`${repository.owner}/${repository.repo}`, signal, async () => {
        const res = await octokit.graphql<{ search: { nodes: RepoIssueNode[] } }>(
          REPO_ISSUES_QUERY,
          { search, request: requestOptions(signal) },
        );
        return res.search.nodes.flatMap((node): GitHubRepoIssue[] => {
          if (!node.url || !node.repository || node.number === undefined) return [];
          return [
            {
              host,
              owner: node.repository.owner.login,
              repo: node.repository.name,
              number: node.number,
              title: node.title ?? "",
              url: node.url,
              author: node.author?.login ?? null,
              updatedAt: node.updatedAt ?? new Date(0).toISOString(),
              assignees: (node.assignees?.nodes ?? []).flatMap((a) => (a ? [a.login] : [])),
            },
          ];
        });
      });
    },

    /**
     * The repository's current name. Follows GitHub's redirect, so a repo
     * renamed since `repository` was read answers with its new name. The
     * merge settings are undefined when GitHub leaves them out, as it does
     * for a token that can't push to the repo.
     */
    getRepo(repository: { owner: string; repo: string }, signal?: AbortSignal) {
      return call(`${repository.owner}/${repository.repo}`, signal, async () => {
        const res = await octokit.rest.repos.get({
          owner: repository.owner,
          repo: repository.repo,
          request: requestOptions(signal),
        });
        return {
          name: res.data.name,
          fullName: res.data.full_name,
          allowMergeCommit: res.data.allow_merge_commit as boolean | undefined,
          allowSquashMerge: res.data.allow_squash_merge as boolean | undefined,
          allowRebaseMerge: res.data.allow_rebase_merge as boolean | undefined,
        };
      });
    },

    /** Renames the repository on GitHub; needs admin rights on it. */
    renameRepo(repository: { owner: string; repo: string }, name: string, signal?: AbortSignal) {
      return call(`${repository.owner}/${repository.repo}`, signal, async () => {
        await octokit.rest.repos.update({
          owner: repository.owner,
          repo: repository.repo,
          name,
          request: requestOptions(signal),
        });
      });
    },

    /** The token's user. */
    getViewer(signal?: AbortSignal) {
      return call("Authenticated user", signal, async () => {
        const res = await octokit.rest.users.getAuthenticated({ request: requestOptions(signal) });
        return { login: res.data.login };
      });
    },

    /** Assigns the issue to the token's user; already assigned is fine. Returns the user's login. */
    assignToViewer(issue: PullRequestCoordinates) {
      return call(prName(issue), undefined, async () => {
        const user = await octokit.rest.users.getAuthenticated({ request: requestOptions() });
        const login = user.data.login;
        await octokit.rest.issues.addAssignees({
          owner: issue.owner,
          repo: issue.repo,
          issue_number: issue.number,
          assignees: [login],
          request: requestOptions(),
        });
        return { login };
      });
    },

    /** The latest check run of each check on the commit. */
    listCheckRuns(commit: CommitCoordinates, signal?: AbortSignal) {
      return call(`Check runs of ${commitName(commit)}`, signal, async () => {
        const all = await octokit.paginate(octokit.rest.checks.listForRef, {
          owner: commit.owner,
          repo: commit.repo,
          ref: commit.ref,
          filter: "latest",
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return all as unknown as GitHubCheckRunJson[];
      });
    },

    /** One check run, with its app and output. */
    getCheckRun(run: { owner: string; repo: string; id: number }, signal?: AbortSignal) {
      return call(`Check run ${run.id} in ${run.owner}/${run.repo}`, signal, async () => {
        const res = await octokit.rest.checks.get({
          owner: run.owner,
          repo: run.repo,
          check_run_id: run.id,
          request: requestOptions(signal),
        });
        return res.data as unknown as GitHubCheckRunJson;
      });
    },

    /** The commit's statuses, the latest per context. */
    getCombinedStatus(commit: CommitCoordinates, signal?: AbortSignal) {
      return call(`Statuses of ${commitName(commit)}`, signal, async () => {
        const res = await octokit.rest.repos.getCombinedStatusForRef({
          owner: commit.owner,
          repo: commit.repo,
          ref: commit.ref,
          per_page: PER_PAGE,
          request: requestOptions(signal),
        });
        return res.data as unknown as GitHubCombinedStatusJson;
      });
    },

    /**
     * A GitHub Actions job's log. GitHub answers with a redirect to a
     * pre-signed URL, fetched without the token so it only goes to the API host.
     */
    getJobLogs(job: { owner: string; repo: string; jobId: number }, signal?: AbortSignal) {
      return call(`Log of job ${job.jobId} in ${job.owner}/${job.repo}`, signal, async () => {
        const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
          owner: job.owner,
          repo: job.repo,
          job_id: job.jobId,
          request: { ...requestOptions(signal), redirect: "manual" },
        });
        const location = headerOf(res.headers as Record<string, unknown>, "location");
        if (!location) {
          if (typeof res.data === "string") return res.data;
          throw new GitHubError(`${host}: GitHub sent no link to the log`);
        }
        const log = await fetchImpl(location, requestOptions(signal));
        if (!log.ok) {
          throw new GitHubError(`${host}: log download failed (${log.status})`, log.status);
        }
        return log.text();
      });
    },

    /** Submits a review with inline comments (see `buildReviewPayload`). */
    createReview(pr: PullRequestCoordinates, payload: ReviewPayload) {
      return call(prName(pr), undefined, async () => {
        const res = await octokit.rest.pulls.createReview({
          owner: pr.owner,
          repo: pr.repo,
          pull_number: pr.number,
          ...payload,
          request: requestOptions(),
        });
        return { id: res.data.id, url: res.data.html_url };
      });
    },
  };
}
