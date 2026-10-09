import { JIRA_EMAIL_META, type Connection, type ConnectionTestResult } from "@blackwall/shared";

export type Fetch = typeof fetch;

/**
 * REST API root for a GitHub base URL: api.github.com for github.com,
 * `api.<sub>.ghe.com` on GitHub Enterprise Cloud (`*.ghe.com`), and
 * `/api/v3` on GitHub Enterprise Server.
 */
export function githubApiUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.host.toLowerCase();
  if (host === "github.com" || host === "www.github.com") return "https://api.github.com";
  if (host.endsWith(".ghe.com")) return `https://api.${host}`;
  return `${url.origin}/api/v3`;
}

const TIMEOUT_MS = 10_000;
const MAX_MESSAGE_CHARS = 200;

type HeaderBag = Headers | Record<string, unknown>;

function headerOf(headers: HeaderBag | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers instanceof Headers ? headers.get(name) : headers[name];
  return value === null || value === undefined ? undefined : String(value);
}

export interface GitHubFailureDetail {
  /** Response headers (a fetch `Headers` or Octokit's lower-cased header object). */
  headers?: HeaderBag | undefined;
  /** GitHub's `message` from the response body. */
  message?: unknown;
  /** Redacted from `message` before it goes into the reason. */
  token?: string | undefined;
}

/**
 * Why GitHub refused a request, for a `${host}: <reason>` message. GitHub's
 * own message is included for 403s with the token redacted and the length
 * capped, so the result never echoes the token.
 */
export function githubFailureReason(status: number, detail: GitHubFailureDetail = {}): string {
  if (status === 401) return "token rejected";
  if (status !== 403) return `unexpected response ${status}`;
  if (headerOf(detail.headers, "x-github-sso") !== undefined) {
    return "token not authorised for SAML SSO (authorise it under Settings → Tokens → Configure SSO)";
  }
  if (headerOf(detail.headers, "x-ratelimit-remaining") === "0") return "rate limit exceeded";
  let message = typeof detail.message === "string" ? detail.message.trim() : "";
  if (detail.token) message = message.split(detail.token).join("***");
  if (message.length > MAX_MESSAGE_CHARS) message = `${message.slice(0, MAX_MESSAGE_CHARS)}…`;
  return message ? `access denied: ${message}` : "access denied (check the token's scopes)";
}

/** Describes a failed response without echoing anything that could contain the token. */
function httpFailureReason(res: Response): string {
  return res.status === 401
    ? "token rejected"
    : res.status === 403
      ? "access denied (check the token's scopes)"
      : `unexpected response ${res.status}`;
}

interface ProbeOptions {
  /** Reason for a non-2xx response; defaults to {@link httpFailureReason}. */
  failure?: (res: Response) => Promise<string>;
  /** Reason to fail a 2xx response, or undefined to accept it. */
  check?: (res: Response) => string | undefined;
}

async function probe(
  url: string,
  headers: Record<string, string>,
  account: (body: Record<string, unknown>) => unknown,
  fetchImpl: Fetch,
  options: ProbeOptions = {},
): Promise<ConnectionTestResult> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, message: `${host}: ${timedOut ? "timed out" : "could not connect"}` };
  }
  if (!res.ok) {
    const reason = options.failure ? await options.failure(res) : httpFailureReason(res);
    return { ok: false, message: `${host}: ${reason}` };
  }
  const rejected = options.check?.(res);
  if (rejected) return { ok: false, message: `${host}: ${rejected}` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const name = account(body);
  return { ok: true, account: typeof name === "string" ? name : "unknown" };
}

/** GitHub/GHE: `GET /user` with the token as a bearer token. */
export function testGitHubConnection(
  baseUrl: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<ConnectionTestResult> {
  return probe(
    `${githubApiUrl(baseUrl)}/user`,
    {
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      accept: "application/vnd.github+json",
    },
    (body) => body.login,
    fetchImpl,
    {
      failure: async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return githubFailureReason(res.status, {
          headers: res.headers,
          message: body.message,
          token,
        });
      },
      // Only classic tokens send their scopes; fine-grained tokens are checked per repo later.
      check: (res) => {
        const scopes = res.headers.get("x-oauth-scopes");
        if (scopes === null) return undefined;
        const granted = scopes.split(",").map((scope) => scope.trim());
        return granted.includes("repo") ? undefined : "token lacks the repo scope";
      },
    },
  );
}

/** Jira Cloud: `GET /rest/api/3/myself` with Basic auth (account email + API token). */
export function testJiraConnection(
  baseUrl: string,
  email: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<ConnectionTestResult> {
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return probe(
    `${new URL(baseUrl).origin}/rest/api/3/myself`,
    { authorization: `Basic ${basic}` },
    (body) => body.displayName ?? body.emailAddress,
    fetchImpl,
  );
}

/** Runs the kind's "Test connection" request with the given token. */
export function testConnection(
  connection: Pick<Connection, "kind" | "baseUrl" | "authMeta">,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<ConnectionTestResult> {
  switch (connection.kind) {
    case "github":
      return testGitHubConnection(connection.baseUrl, token, fetchImpl);
    case "jira": {
      const email = connection.authMeta[JIRA_EMAIL_META];
      if (!email) {
        return Promise.resolve({ ok: false, message: "Jira connection has no account email" });
      }
      return testJiraConnection(connection.baseUrl, email, token, fetchImpl);
    }
  }
}
