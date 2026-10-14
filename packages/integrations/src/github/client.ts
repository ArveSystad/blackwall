import { Octokit } from "@octokit/rest";
import { githubApiUrl, githubFailureReason, type Fetch } from "../connection-test.js";
import type { ReviewPayload } from "./review.js";

/** A GitHub.com or GHE host and a personal access token for it. */
export interface GitHubCredentials {
  /** Web URL of the host (`https://github.com`, `https://acme.ghe.com`); the API root is derived. */
  baseUrl: string;
  token: string;
}

/** A failed GitHub request. The message never contains the token. */
export class GitHubError extends Error {
  constructor(
    message: string,
    /** HTTP status; undefined when the request never got a response. */
    readonly status?: number,
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
    return new GitHubError(`${host}: ${reason}`, status);
  }

  function requestOptions(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    return { signal: signal ? AbortSignal.any([timeout, signal]) : timeout };
  }

  async function call<T>(what: string, signal: AbortSignal | undefined, run: () => Promise<T>) {
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failure(error, what);
    }
  }

  const prName = ({ owner, repo, number }: PullRequestCoordinates) => `${owner}/${repo}#${number}`;

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
