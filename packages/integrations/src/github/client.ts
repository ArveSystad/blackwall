import { Octokit } from "@octokit/rest";
import { githubApiUrl, githubFailureReason, type Fetch } from "../connection-test.js";
import type { ReviewPayload } from "./review.js";

/** A GitHub.com or GHE host and a personal access token for it. */
export interface GitHubCredentials {
  /** Web URL of the host (`https://github.com`, `https://jbf.ghe.com`); the API root is derived. */
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
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
  base: { ref: string; sha: string; repo?: { full_name: string } | null };
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

export interface PullRequestCoordinates {
  owner: string;
  repo: string;
  number: number;
}

const TIMEOUT_MS = 30_000;
const PER_PAGE = 100;

export type GitHubClient = ReturnType<typeof createGitHubClient>;

/** HTTP status of a response GitHub sent; undefined when the request never got one. */
function statusOf(error: unknown): number | undefined {
  // Octokit reports network failures as status 500 without a response.
  const { status, response } = (error ?? {}) as { status?: unknown; response?: unknown };
  return response !== undefined && typeof status === "number" ? status : undefined;
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
