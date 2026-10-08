import { JIRA_EMAIL_META, type Connection, type ConnectionTestResult } from "@blackwall/shared";

export type Fetch = typeof fetch;

/** REST API root for a GitHub base URL: api.github.com for github.com, `/api/v3` on GHE. */
export function githubApiUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const host = url.host.toLowerCase();
  if (host === "github.com" || host === "www.github.com") return "https://api.github.com";
  return `${url.origin}/api/v3`;
}

const TIMEOUT_MS = 10_000;

/** Describes a failed response without echoing anything that could contain the token. */
function httpFailure(res: Response, host: string): ConnectionTestResult {
  const reason =
    res.status === 401
      ? "token rejected"
      : res.status === 403
        ? "access denied (check the token's scopes)"
        : `unexpected response ${res.status}`;
  return { ok: false, message: `${host}: ${reason}` };
}

async function probe(
  url: string,
  headers: Record<string, string>,
  account: (body: Record<string, unknown>) => unknown,
  fetchImpl: Fetch,
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
  if (!res.ok) return httpFailure(res, host);
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
