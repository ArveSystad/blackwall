import { describe, expect, it, vi } from "vitest";
import { githubApiUrl, testConnection } from "./connection-test.js";

const TOKEN = "ghp_supersecret123";

function fakeFetch(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers })),
  );
}

function headersOf(fetchImpl: ReturnType<typeof fakeFetch>) {
  const [url, init] = fetchImpl.mock.calls[0] ?? [];
  return { url, headers: init?.headers as Record<string, string> };
}

describe("githubApiUrl", () => {
  it("maps github.com to api.github.com, GHE.com to api.<sub> and GHE Server to /api/v3", () => {
    expect(githubApiUrl("https://github.com")).toBe("https://api.github.com");
    expect(githubApiUrl("https://jbf.ghe.com")).toBe("https://api.jbf.ghe.com");
    expect(githubApiUrl("https://git.acme.test")).toBe("https://git.acme.test/api/v3");
  });
});

describe("testConnection", () => {
  it("calls GET /user on GHE with a bearer token", async () => {
    const fetchImpl = fakeFetch(200, { login: "octocat" });
    const result = await testConnection(
      { kind: "github", baseUrl: "https://jbf.ghe.com", authMeta: {} },
      TOKEN,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, account: "octocat" });
    const { url, headers } = headersOf(fetchImpl);
    expect(url).toBe("https://api.jbf.ghe.com/user");
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("calls GET /rest/api/3/myself on Jira with Basic auth", async () => {
    const fetchImpl = fakeFetch(200, { displayName: "Ada" });
    const result = await testConnection(
      { kind: "jira", baseUrl: "https://acme.atlassian.net", authMeta: { email: "a@acme.test" } },
      TOKEN,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, account: "Ada" });
    const { url, headers } = headersOf(fetchImpl);
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    const basic = Buffer.from(`a@acme.test:${TOKEN}`).toString("base64");
    expect(headers.authorization).toBe(`Basic ${basic}`);
  });

  it("reports rejected tokens and network failures without the token", async () => {
    const conn = { kind: "github", baseUrl: "https://github.com", authMeta: {} } as const;
    const rejected = await testConnection(conn, TOKEN, fakeFetch(401));
    expect(rejected).toEqual({ ok: false, message: "api.github.com: token rejected" });

    const offline = await testConnection(conn, TOKEN, () => Promise.reject(new Error(TOKEN)));
    expect(offline).toEqual({ ok: false, message: "api.github.com: could not connect" });
  });

  it("fails a classic token without the repo scope", async () => {
    const conn = { kind: "github", baseUrl: "https://jbf.ghe.com", authMeta: {} } as const;
    const user = { login: "octocat" };
    const narrow = fakeFetch(200, user, { "x-oauth-scopes": "read:org, public_repo" });
    expect(await testConnection(conn, TOKEN, narrow)).toEqual({
      ok: false,
      message: "api.jbf.ghe.com: token lacks the repo scope",
    });

    const wide = fakeFetch(200, user, { "x-oauth-scopes": "repo, read:org" });
    expect(await testConnection(conn, TOKEN, wide)).toEqual({ ok: true, account: "octocat" });

    const fineGrained = fakeFetch(200, user);
    expect(await testConnection(conn, TOKEN, fineGrained)).toEqual({
      ok: true,
      account: "octocat",
    });
  });

  it("names SSO, rate limits and GitHub's redacted message on a 403", async () => {
    const conn = { kind: "github", baseUrl: "https://jbf.ghe.com", authMeta: {} } as const;
    const sso = fakeFetch(403, { message: "SAML" }, { "x-github-sso": "required; url=x" });
    expect(await testConnection(conn, TOKEN, sso)).toEqual({
      ok: false,
      message:
        "api.jbf.ghe.com: token not authorised for SAML SSO (authorise it under Settings → Tokens → Configure SSO)",
    });

    const limited = fakeFetch(403, { message: "API rate limit" }, { "x-ratelimit-remaining": "0" });
    expect(await testConnection(conn, TOKEN, limited)).toEqual({
      ok: false,
      message: "api.jbf.ghe.com: rate limit exceeded",
    });

    const echo = fakeFetch(403, { message: `Token ${TOKEN} cannot read this` });
    expect(await testConnection(conn, TOKEN, echo)).toEqual({
      ok: false,
      message: "api.jbf.ghe.com: access denied: Token *** cannot read this",
    });
  });

  it("fails a Jira connection without an email", async () => {
    const fetchImpl = fakeFetch(200);
    const result = await testConnection(
      { kind: "jira", baseUrl: "https://acme.atlassian.net", authMeta: {} },
      TOKEN,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
