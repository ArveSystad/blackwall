import type { Fetch } from "../connection-test.js";
import type { AdfDoc, AdfNode } from "./adf.js";
import { markdownToAdf } from "./markdown-to-adf.js";

/** Jira Cloud site and account: Basic auth is the account email plus an API token. */
export interface JiraCredentials {
  baseUrl: string;
  email: string;
  token: string;
}

/** A failed Jira request. The message never contains the token. */
export class JiraError extends Error {
  constructor(
    message: string,
    /** HTTP status; undefined when the request never got a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

/** A linked, parent or sub-task issue as Jira embeds it. */
export interface JiraIssueSummaryJson {
  id?: string;
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    description?: AdfNode | string | null;
  };
}

export interface JiraUserJson {
  displayName?: string;
  emailAddress?: string;
}

export interface JiraCommentJson {
  id: string;
  author?: JiraUserJson;
  body?: AdfNode | string | null;
  created?: string;
}

export interface JiraAttachmentJson {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  created?: string;
  author?: JiraUserJson;
}

export interface JiraIssueLinkJson {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraIssueSummaryJson;
  outwardIssue?: JiraIssueSummaryJson;
}

/** `GET /rest/api/3/issue/{key}` with the fields Inform reads. */
export interface JiraIssueJson {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    issuetype?: { name?: string };
    status?: { name?: string };
    priority?: { name?: string } | null;
    labels?: string[];
    reporter?: JiraUserJson | null;
    assignee?: JiraUserJson | null;
    parent?: JiraIssueSummaryJson;
    subtasks?: JiraIssueSummaryJson[];
    issuelinks?: JiraIssueLinkJson[];
    attachment?: JiraAttachmentJson[];
    comment?: { comments?: JiraCommentJson[]; total?: number };
  };
}

/** One issue of `GET /rest/api/3/search/jql` with the fields the Backlog lists. */
export interface JiraSearchIssueJson {
  id: string;
  key: string;
  fields: {
    summary?: string;
    issuetype?: { name?: string } | null;
    status?: { name?: string } | null;
    assignee?: JiraUserJson | null;
    reporter?: JiraUserJson | null;
    updated?: string;
  };
}

interface CommentPage {
  comments?: JiraCommentJson[];
  startAt?: number;
  total?: number;
}

/** Fields fetched for an issue: everything Inform turns into context. */
export const ISSUE_FIELDS = [
  "summary",
  "description",
  "issuetype",
  "status",
  "priority",
  "labels",
  "reporter",
  "assignee",
  "parent",
  "subtasks",
  "issuelinks",
  "attachment",
  "comment",
] as const;

const TIMEOUT_MS = 30_000;
const COMMENT_PAGE = 100;
const SEARCH_PAGE = 100;

export type JiraClient = ReturnType<typeof createJiraClient>;

/**
 * Jira Cloud REST v3 client with Basic auth. Requests only ever go to the
 * site's own origin, so the token cannot leak to another host.
 */
export function createJiraClient(credentials: JiraCredentials, fetchImpl: Fetch = fetch) {
  const origin = new URL(credentials.baseUrl).origin;
  const host = new URL(origin).host;
  const authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`;

  function failure(status: number, what: string): JiraError {
    const reason =
      status === 401
        ? "token rejected"
        : status === 403
          ? "access denied"
          : status === 404
            ? `${what} not found (or not visible to this account)`
            : `unexpected response ${status}`;
    return new JiraError(`${host}: ${reason}`, status);
  }

  async function request(
    path: string,
    what: string,
    init: { method?: string; body?: unknown; accept?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization,
      accept: init.accept ?? "application/json",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new JiraError(`${host}: ${timedOut ? "timed out" : "could not connect"}`);
    }
    if (!res.ok) throw failure(res.status, what);
    return res;
  }

  async function json<T>(path: string, what: string, signal?: AbortSignal): Promise<T> {
    const res = await request(path, what, signal ? { signal } : {});
    return (await res.json()) as T;
  }

  const issuePath = (key: string) => `/rest/api/3/issue/${encodeURIComponent(key)}`;

  return {
    baseUrl: origin,

    /** Browser link to an issue. */
    browseUrl: (key: string) => `${origin}/browse/${encodeURIComponent(key)}`,

    /** The issue with the fields in {@link ISSUE_FIELDS}. */
    getIssue(key: string, signal?: AbortSignal): Promise<JiraIssueJson> {
      const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(",") });
      return json<JiraIssueJson>(`${issuePath(key)}?${query}`, `Issue ${key}`, signal);
    },

    /** Summary, type, status and description of another issue (e.g. the parent epic). */
    getIssueSummary(key: string, signal?: AbortSignal): Promise<JiraIssueSummaryJson> {
      const query = new URLSearchParams({ fields: "summary,issuetype,status,description" });
      return json<JiraIssueSummaryJson>(`${issuePath(key)}?${query}`, `Issue ${key}`, signal);
    },

    /** Every comment on the issue, oldest first, following pagination. */
    async getComments(key: string, signal?: AbortSignal): Promise<JiraCommentJson[]> {
      const all: JiraCommentJson[] = [];
      for (;;) {
        const query = new URLSearchParams({
          startAt: String(all.length),
          maxResults: String(COMMENT_PAGE),
          orderBy: "created",
        });
        const page = await json<CommentPage>(
          `${issuePath(key)}/comment?${query}`,
          `Issue ${key}`,
          signal,
        );
        const comments = page.comments ?? [];
        all.push(...comments);
        if (comments.length === 0 || all.length >= (page.total ?? 0)) return all;
      }
    },

    /**
     * The first page (at most `maxResults`, default 100) of issues matching
     * the JQL, with summary, type, status, assignee, reporter and update time.
     */
    async searchIssues(
      jql: string,
      options: { maxResults?: number; signal?: AbortSignal } = {},
    ): Promise<JiraSearchIssueJson[]> {
      const query = new URLSearchParams({
        jql,
        fields: "summary,issuetype,status,assignee,reporter,updated",
        maxResults: String(options.maxResults ?? SEARCH_PAGE),
      });
      const page = await json<{ issues?: JiraSearchIssueJson[] }>(
        `/rest/api/3/search/jql?${query}`,
        "Project",
        options.signal,
      );
      return page.issues ?? [];
    },

    /** Posts a comment; markdown is converted to ADF. Returns the new comment's id. */
    async addComment(key: string, body: string | AdfDoc): Promise<{ id: string }> {
      const doc = typeof body === "string" ? markdownToAdf(body) : body;
      const res = await request(`${issuePath(key)}/comment`, `Issue ${key}`, {
        method: "POST",
        body: { body: doc },
      });
      const created = (await res.json()) as { id?: string };
      return { id: String(created.id ?? "") };
    },

    /**
     * Downloads an attachment's bytes, reading at most `maxBytes`. Jira
     * redirects to its media store; the redirect target is pre-signed.
     * Returns undefined when the file is larger than the cap.
     */
    async downloadAttachment(
      id: string,
      maxBytes: number,
      signal?: AbortSignal,
    ): Promise<Uint8Array | undefined> {
      const res = await request(
        `/rest/api/3/attachment/content/${encodeURIComponent(id)}`,
        `Attachment ${id}`,
        { accept: "*/*", ...(signal ? { signal } : {}) },
      );
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel();
        return undefined;
      }
      if (!res.body) return new Uint8Array(await res.arrayBuffer());
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    },
  };
}
