import { readFileSync } from "node:fs";
import type { ReviewFinding } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, GitHubError } from "./client.js";
import { informFromPullRequest } from "./inform.js";
import { assembleIssue, informFromIssue, renderIssue } from "./issue.js";
import {
  findRepoForPullRequest,
  parseIssueUrl,
  parsePullRequestUrl,
  parseRemoteSlug,
  type PullRequestRef,
} from "./pr-ref.js";
import { assemblePullRequest, findJiraKey } from "./pull-request.js";
import { buildReviewPayload, commentableLines } from "./review.js";
import { COMMENT_SIGNATURE, signComment } from "./signature.js";

const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fixtureText = (name: string) => readFileSync(fixturePath(name), "utf8");
const jiraFixtureText = (name: string) =>
  readFileSync(new URL(`../jira/fixtures/${name}`, import.meta.url), "utf8");

const TOKEN = "ghp_secret_token";
const GHE = { baseUrl: "https://acme.ghe.com", token: TOKEN };
const PR = { owner: "acme", repo: "shop", number: 42 };
const ISSUE = { owner: "acme", repo: "shop", number: 7 };
const DIFF = fixtureText("pr-42.diff");

const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Serves the recorded PR fixtures under the GHE.com API root, like GitHub would. */
function recordedGitHub() {
  return vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const path = url.pathname;
    if (path === "/repos/acme/shop/pulls/42") {
      return Promise.resolve(
        accept.includes("diff")
          ? new Response(DIFF, { headers: { "content-type": "text/plain; charset=utf-8" } })
          : json(fixtureText("pr-42.json")),
      );
    }
    if (path === "/repos/acme/shop/pulls/42/comments")
      return Promise.resolve(json(fixtureText("review-comments-42.json")));
    if (path === "/repos/acme/shop/issues/42/comments")
      return Promise.resolve(json(fixtureText("issue-comments-42.json")));
    if (path === "/repos/acme/shop/issues/42")
      return Promise.resolve(json(fixtureText("issue-is-pr.json")));
    if (path === "/repos/acme/shop/issues/7")
      return Promise.resolve(json(fixtureText("issue.json")));
    if (path === "/repos/acme/shop/issues/7/comments")
      return Promise.resolve(json(fixtureText("issue-comments.json")));
    if (path === "/repos/acme/shop/pulls/42/reviews")
      return Promise.resolve(json(fixtureText("reviews-42.json")));
    if (path === "/rest/api/3/issue/ABC-123")
      return Promise.resolve(json(jiraFixtureText("issue-abc-123.json")));
    if (path === "/rest/api/3/issue/ABC-123/comment")
      return Promise.resolve(json(jiraFixtureText("comments-abc-123.json")));
    if (path === "/rest/api/3/issue/ABC-100")
      return Promise.resolve(json(jiraFixtureText("parent-abc-100.json")));
    return Promise.resolve(json('{"message":"Not Found"}', 404));
  });
}

describe("parsePullRequestUrl", () => {
  it("parses github.com and GHE PR links, with sub-pages", () => {
    expect(parsePullRequestUrl(" https://github.com/acme/shop/pull/42 ")).toEqual({
      baseUrl: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "shop",
      number: 42,
      url: "https://github.com/acme/shop/pull/42",
    });
    expect(parsePullRequestUrl("https://ACME.ghe.com/team/api/pull/7/files#diff-1")).toEqual({
      baseUrl: "https://acme.ghe.com",
      host: "acme.ghe.com",
      owner: "team",
      repo: "api",
      number: 7,
      url: "https://acme.ghe.com/team/api/pull/7",
    });
    expect(parsePullRequestUrl("https://www.github.com/acme/shop/pulls/3")?.host).toBe(
      "github.com",
    );
  });

  it("rejects other links", () => {
    expect(parsePullRequestUrl("acme/shop#42")).toBeUndefined();
    expect(parsePullRequestUrl("https://github.com/acme/shop/issues/42")).toBeUndefined();
    expect(parsePullRequestUrl("https://github.com/acme/shop/pull/0")).toBeUndefined();
    expect(parsePullRequestUrl("ftp://github.com/acme/shop/pull/1")).toBeUndefined();
  });
});

describe("parseIssueUrl", () => {
  it("parses github.com and GHE issue links, with a trailing slash or anchor", () => {
    expect(parseIssueUrl(" https://github.com/acme/shop/issues/7/ ")).toEqual({
      baseUrl: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "shop",
      number: 7,
      url: "https://github.com/acme/shop/issues/7",
    });
    expect(parseIssueUrl("https://ACME.ghe.com/team/api/issues/12#issuecomment-1")).toEqual({
      baseUrl: "https://acme.ghe.com",
      host: "acme.ghe.com",
      owner: "team",
      repo: "api",
      number: 12,
      url: "https://acme.ghe.com/team/api/issues/12",
    });
    expect(parseIssueUrl("https://www.github.com/acme/shop/issues/3")?.url).toBe(
      "https://github.com/acme/shop/issues/3",
    );
  });

  it("rejects pull request and other links", () => {
    expect(parseIssueUrl("https://github.com/acme/shop/pull/7")).toBeUndefined();
    expect(parseIssueUrl("https://github.com/acme/shop/issues")).toBeUndefined();
    expect(parseIssueUrl("https://github.com/acme/shop/issues/0")).toBeUndefined();
    expect(parseIssueUrl("acme/shop#7")).toBeUndefined();
  });
});

describe("repo matching", () => {
  const ref = parsePullRequestUrl("https://github.com/Acme/Shop/pull/42") as PullRequestRef;

  it("reads owner/repo from https, ssh and scp-like remotes", () => {
    expect(parseRemoteSlug("https://github.com/acme/shop.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "shop",
    });
    expect(parseRemoteSlug("git@acme.ghe.com:team/api.git")).toEqual({
      host: "acme.ghe.com",
      owner: "team",
      repo: "api",
    });
    expect(parseRemoteSlug("ssh://git@ssh.github.com:443/acme/shop")?.host).toBe("github.com");
    expect(parseRemoteSlug("C:\\code\\shop")).toBeUndefined();
    expect(parseRemoteSlug("https://github.com/acme")).toBeUndefined();
  });

  it("finds the registered repo by host and owner/repo, case-insensitively", () => {
    const repos = [
      { id: "r1", remoteUrl: null },
      { id: "r2", remoteUrl: "git@github.com:acme/shop-legacy.git" },
      { id: "r3", remoteUrl: "https://acme.ghe.com/acme/shop.git" },
      { id: "r4", remoteUrl: "git@github.com:acme/shop.git" },
    ];
    expect(findRepoForPullRequest(repos, ref)?.id).toBe("r4");
    expect(findRepoForPullRequest(repos.slice(0, 3), ref)).toBeUndefined();
    const issue = parseIssueUrl("https://acme.ghe.com/ACME/shop/issues/7");
    expect(issue && findRepoForPullRequest(repos, issue)?.id).toBe("r3");
  });
});

describe("findJiraKey", () => {
  it("prefers the branch, in any case, then an upper-case key in the title", () => {
    expect(findJiraKey("fix/abc-123-invoice-totals", "Round totals")).toBe("ABC-123");
    expect(findJiraKey("ABC-9", "")).toBe("ABC-9");
    expect(findJiraKey("main", "ABC-77: Round totals")).toBe("ABC-77");
    expect(findJiraKey("main", "[ABC-77] Round totals")).toBe("ABC-77");
  });

  it("ignores keys that are not at a branch segment start or are lower case in the title", () => {
    expect(findJiraKey("feature/round-abc-123", "Support utf-8 export")).toBeUndefined();
  });
});

describe("assemblePullRequest", () => {
  const context = assemblePullRequest(PR, {
    pullRequest: JSON.parse(fixtureText("pr-42.json")),
    diff: DIFF,
    reviewComments: JSON.parse(fixtureText("review-comments-42.json")),
    issueComments: JSON.parse(fixtureText("issue-comments-42.json")),
    reviews: JSON.parse(fixtureText("reviews-42.json")),
  });

  it("flattens the PR metadata", () => {
    expect(context).toMatchObject({
      number: 42,
      title: "Round invoice totals once",
      state: "open",
      author: "ada",
      labels: ["bug", "billing"],
      headRef: "fix/abc-123-invoice-totals-are-rounded-twice",
      headSha: "9f1c2d3e4b5a69788796a5b4c3d2e1f009182736",
      baseRef: "main",
      stats: { additions: 4, deletions: 3, changedFiles: 2 },
    });
  });

  it("groups replies into their review thread, oldest first", () => {
    expect(context.threads).toEqual([
      expect.objectContaining({
        path: "src/invoices/totals.ts",
        line: 6,
        comments: [
          expect.objectContaining({ author: "grace", body: expect.stringContaining("overflow") }),
          expect.objectContaining({ author: "ada", body: expect.stringContaining("øre") }),
        ],
      }),
      expect.objectContaining({ path: "src/export/csv.ts", line: 13 }),
    ]);
  });

  it("merges conversation comments and review summaries, skipping empty ones", () => {
    expect(context.conversation.map((c) => [c.author, c.reviewState ?? null])).toEqual([
      ["ada", null],
      ["grace", "CHANGES_REQUESTED"],
    ]);
  });
});

describe("informFromPullRequest", () => {
  it("renders the recorded PR with its linked Jira issue as agent context", async () => {
    const fetchImpl = recordedGitHub();
    const result = await informFromPullRequest(GHE, PR, {
      fetch: fetchImpl,
      jira: { baseUrl: "https://acme.atlassian.net", email: "ada@acme.test", token: "jira-tok" },
    });
    expect(result.jiraKey).toBe("ABC-123");
    expect(result.jira?.issue.key).toBe("ABC-123");
    expect(result.markdown).toBe(fixtureText("pr-42.context.md").trimEnd());

    const github = fetchImpl.mock.calls.filter(([url]) => String(url).includes("acme.ghe.com"));
    expect(github.length).toBe(5);
    for (const [url, init] of github) {
      expect(String(url)).toMatch(/^https:\/\/api\.acme\.ghe\.com\/repos\/acme\/shop\//);
      expect(new Headers(init?.headers).get("authorization")).toBe(`token ${TOKEN}`);
    }
  });

  it("only names the Jira key without a Jira connection", async () => {
    const result = await informFromPullRequest(GHE, PR, { fetch: recordedGitHub() });
    expect(result.jira).toBeUndefined();
    expect(result.markdown).toContain("refers to Jira issue ABC-123; no Jira connection");
  });

  it("ignores a key that matches no issue", async () => {
    const fetchImpl = recordedGitHub();
    const result = await informFromPullRequest(GHE, PR, {
      fetch: (input, init) =>
        String(input).includes("atlassian")
          ? Promise.resolve(json("{}", 404))
          : fetchImpl(input, init),
      jira: { baseUrl: "https://acme.atlassian.net", email: "ada@acme.test", token: "jira-tok" },
    });
    expect(result.jiraKey).toBe("ABC-123");
    expect(result.jira).toBeUndefined();
    expect(result.markdown).not.toContain("ABC-123;");
  });

  it("cuts long diffs and says how to see the rest", async () => {
    const result = await informFromPullRequest(GHE, PR, {
      fetch: recordedGitHub(),
      maxDiffChars: 100,
    });
    expect(result.markdown).toContain(`The diff is cut at 100 of ${DIFF.length} characters.`);
    expect(result.markdown).toContain("git diff main...HEAD");
  });
});

describe("GitHub issues", () => {
  const context = assembleIssue(ISSUE, {
    issue: JSON.parse(fixtureText("issue.json")),
    comments: JSON.parse(fixtureText("issue-comments.json")),
  });

  it("flattens the issue and skips empty comments", () => {
    expect(context).toEqual({
      owner: "acme",
      repo: "shop",
      number: 7,
      url: "https://acme.ghe.com/acme/shop/issues/7",
      title: "Invoice export drops the last row",
      description:
        "The CSV export misses the final invoice line.\n\n## Steps\n\n1. Export March\n2. Count rows",
      state: "open",
      author: "grace",
      labels: ["Bug", "billing"],
      conversation: [
        {
          author: "ada",
          body: "Seen it too, only for months with 31 days.",
          created: "2026-10-02T09:00:00Z",
        },
      ],
    });
  });

  it("renders the issue as agent context", () => {
    expect(renderIssue(context)).toBe(
      [
        "## Issue acme/shop#7: Invoice export drops the last row",
        "State: open · Author: grace · Labels: Bug, billing\nhttps://acme.ghe.com/acme/shop/issues/7",
        "### Description\n\nThe CSV export misses the final invoice line.\n\n##### Steps\n\n1. Export March\n2. Count rows",
        "### Conversation\n\n**ada** (2026-10-02):\n\nSeen it too, only for months with 31 days.",
      ].join("\n\n"),
    );
  });

  it("fetches the issue and its comments", async () => {
    const fetchImpl = recordedGitHub();
    const result = await informFromIssue(GHE, ISSUE, { fetch: fetchImpl });
    expect(result.markdown).toBe(renderIssue(context));
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual([
      "/repos/acme/shop/issues/7",
      "/repos/acme/shop/issues/7/comments",
    ]);
  });

  it("refuses an issue link that is really a pull request", async () => {
    await expect(informFromIssue(GHE, PR, { fetch: recordedGitHub() })).rejects.toThrow(
      "acme/shop#42 is a pull request; use the GitHub PR origin",
    );
  });
});

describe("GitHub client", () => {
  it("uses api.github.com for github.com", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json('{"number":5,"html_url":"https://github.com/acme/shop/pull/5"}', 201)),
    );
    const client = createGitHubClient({ baseUrl: "https://github.com", token: TOKEN }, fetchImpl);
    expect(client.apiUrl).toBe("https://api.github.com");
    await client.createPullRequest({
      owner: "acme",
      repo: "shop",
      head: "feature/abc-1-x",
      base: "main",
      title: "ABC-1: X",
      body: "Summary",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/repos/acme/shop/pulls");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      head: "feature/abc-1-x",
      base: "main",
      title: "ABC-1: X",
      body: "Summary",
    });
  });

  it("posts a PR comment on the issue endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json('{"id":1,"html_url":"https://acme.ghe.com/x"}', 201)),
    );
    await createGitHubClient(GHE, fetchImpl).addComment(PR, "Done.");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.acme.ghe.com/repos/acme/shop/issues/42/comments");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "Done." });
  });

  it("uses /api/v3 on GitHub Enterprise Server", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json('{"id":1,"html_url":"https://git.acme.test/x"}', 201)),
    );
    const client = createGitHubClient(
      { baseUrl: "https://git.acme.test", token: TOKEN },
      fetchImpl,
    );
    expect(client.apiUrl).toBe("https://git.acme.test/api/v3");
    await client.addComment(PR, "Done.");
    const [url] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://git.acme.test/api/v3/repos/acme/shop/issues/42/comments");
  });

  it("reports failures without the token", async () => {
    const client = createGitHubClient(GHE, () =>
      Promise.resolve(json('{"message":"Bad credentials"}', 401)),
    );
    const error = await client.getPullRequest(PR).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(401);
    expect((error as GitHubError).message).toBe("acme.ghe.com: token rejected");

    const offline = createGitHubClient(GHE, () => Promise.reject(new TypeError("fetch failed")));
    const down = await offline.getPullRequest(PR).catch((e: unknown) => e);
    expect((down as GitHubError).message).toBe("acme.ghe.com: could not connect");
    expect(String((down as GitHubError).message)).not.toContain(TOKEN);

    const denied = createGitHubClient(GHE, () =>
      Promise.resolve(json('{"message":"Resource not accessible by personal access token"}', 403)),
    );
    const forbidden = await denied.getPullRequest(PR).catch((e: unknown) => e);
    expect((forbidden as GitHubError).status).toBe(403);
    expect((forbidden as GitHubError).message).toBe(
      "acme.ghe.com: access denied: Resource not accessible by personal access token",
    );

    const sso = createGitHubClient(GHE, () =>
      Promise.resolve(
        new Response(`{"message":"SAML enforcement for ${TOKEN}"}`, {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-github-sso": "required; url=https://acme.ghe.com/orgs/acme/sso",
          },
        }),
      ),
    );
    const ssoError = (await sso.getPullRequest(PR).catch((e: unknown) => e)) as GitHubError;
    expect(ssoError.message).toBe(
      "acme.ghe.com: token not authorised for SAML SSO (authorise it under Settings → Tokens → Configure SSO)",
    );
  });
});

describe("review requests search", () => {
  const node = (number: number, patch: Record<string, unknown> = {}) => ({
    url: `https://acme.ghe.com/acme/shop/pull/${number}`,
    number,
    title: `PR ${number}`,
    updatedAt: "2026-10-01T10:00:00Z",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "kari" },
    repository: { name: "shop", owner: { login: "acme" } },
    ...patch,
  });
  const answering = (body: unknown) =>
    vi.fn<typeof fetch>(() => Promise.resolve(json(JSON.stringify(body))));

  it("posts one search to the host's GraphQL endpoint", async () => {
    const empty = { data: { search: { nodes: [] } } };
    const github = answering(empty);
    await createGitHubClient(
      { baseUrl: "https://github.com", token: TOKEN },
      github,
    ).searchReviewRequests();
    const [url, init] = github.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/graphql");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`token ${TOKEN}`);
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { search: string };
    };
    expect(query).toContain("search(type: ISSUE");
    expect(variables.search).toContain("review-requested:@me");
    expect(variables.search).toContain("-review:approved");
    expect(variables.search).toContain("draft:false");

    const ghe = answering(empty);
    await createGitHubClient(GHE, ghe).searchReviewRequests();
    expect(String(ghe.mock.calls[0]![0])).toBe("https://api.acme.ghe.com/graphql");
    expect(new Headers(ghe.mock.calls[0]![1]?.headers).get("authorization")).toBe(`token ${TOKEN}`);

    const server = answering(empty);
    await createGitHubClient(
      { baseUrl: "https://git.acme.test", token: TOKEN },
      server,
    ).searchReviewRequests();
    expect(String(server.mock.calls[0]![0])).toBe("https://git.acme.test/api/graphql");
  });

  it("maps pull requests and drops approved and draft ones", async () => {
    const github = answering({
      data: {
        search: {
          nodes: [
            node(1),
            node(2, { reviewDecision: "CHANGES_REQUESTED", author: null }),
            node(3, { reviewDecision: null }),
            node(4, { reviewDecision: "APPROVED" }),
            node(5, { isDraft: true }),
            {},
          ],
        },
      },
    });
    const rows = await createGitHubClient(GHE, github).searchReviewRequests();
    expect(rows).toEqual([
      {
        host: "acme.ghe.com",
        owner: "acme",
        repo: "shop",
        number: 1,
        title: "PR 1",
        url: "https://acme.ghe.com/acme/shop/pull/1",
        author: "kari",
        updatedAt: "2026-10-01T10:00:00Z",
        reviewDecision: "review-required",
      },
      expect.objectContaining({ number: 2, author: null, reviewDecision: "changes-requested" }),
      expect.objectContaining({ number: 3, reviewDecision: null }),
    ]);
  });

  it("reports GraphQL errors with the host and without the token", async () => {
    const github = answering({
      data: null,
      errors: [{ type: "FORBIDDEN", message: `SAML SSO enforced for ${TOKEN}` }],
    });
    const error = await createGitHubClient(GHE, github)
      .searchReviewRequests()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).message).toMatch(/^acme\.ghe\.com: SAML SSO enforced/);
    expect((error as GitHubError).message).not.toContain(TOKEN);
  });
});

describe("assigned issues search", () => {
  const node = (number: number, patch: Record<string, unknown> = {}) => ({
    url: `https://acme.ghe.com/acme/shop/issues/${number}`,
    number,
    title: `Issue ${number}`,
    updatedAt: "2026-10-01T10:00:00Z",
    author: { login: "kari" },
    repository: { name: "shop", owner: { login: "acme" } },
    ...patch,
  });
  const answering = (body: unknown) =>
    vi.fn<typeof fetch>(() => Promise.resolve(json(JSON.stringify(body))));

  it("posts one search to the host's GraphQL endpoint", async () => {
    const empty = { data: { search: { nodes: [] } } };
    const github = answering(empty);
    await createGitHubClient(
      { baseUrl: "https://github.com", token: TOKEN },
      github,
    ).searchAssignedIssues();
    const [url, init] = github.mock.calls[0]!;
    expect(String(url)).toBe("https://api.github.com/graphql");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`token ${TOKEN}`);
    const { query, variables } = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { search: string };
    };
    expect(query).toContain("search(type: ISSUE");
    expect(query).toContain("... on Issue");
    expect(variables.search).toContain("is:issue");
    expect(variables.search).toContain("is:open");
    expect(variables.search).toContain("assignee:@me");

    const ghe = answering(empty);
    await createGitHubClient(GHE, ghe).searchAssignedIssues();
    expect(String(ghe.mock.calls[0]![0])).toBe("https://api.acme.ghe.com/graphql");
    expect(new Headers(ghe.mock.calls[0]![1]?.headers).get("authorization")).toBe(`token ${TOKEN}`);

    const server = answering(empty);
    await createGitHubClient(
      { baseUrl: "https://git.acme.test", token: TOKEN },
      server,
    ).searchAssignedIssues();
    expect(String(server.mock.calls[0]![0])).toBe("https://git.acme.test/api/graphql");
  });

  it("maps issues and drops empty nodes", async () => {
    const github = answering({
      data: { search: { nodes: [node(1), node(2, { author: null }), {}] } },
    });
    const rows = await createGitHubClient(GHE, github).searchAssignedIssues();
    expect(rows).toEqual([
      {
        host: "acme.ghe.com",
        owner: "acme",
        repo: "shop",
        number: 1,
        title: "Issue 1",
        url: "https://acme.ghe.com/acme/shop/issues/1",
        author: "kari",
        updatedAt: "2026-10-01T10:00:00Z",
      },
      expect.objectContaining({ number: 2, author: null }),
    ]);
  });

  it("reports GraphQL errors with the host and without the token", async () => {
    const github = answering({
      data: null,
      errors: [{ type: "FORBIDDEN", message: `SAML SSO enforced for ${TOKEN}` }],
    });
    const error = await createGitHubClient(GHE, github)
      .searchAssignedIssues()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).message).toMatch(/^acme\.ghe\.com: SAML SSO enforced/);
    expect((error as GitHubError).message).not.toContain(TOKEN);
  });
});

const finding = (patch: Partial<ReviewFinding>): ReviewFinding => ({
  severity: "Medium",
  tags: [],
  file: null,
  lineStart: null,
  lineEnd: null,
  title: "Finding",
  explanation: "Explanation.",
  suggestedFix: null,
  ...patch,
});

describe("review payloads", () => {
  it("maps the diff's new-side lines per file and hunk", () => {
    const lines = commentableLines(DIFF);
    expect([...lines.get("src/export/csv.ts")!.keys()]).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect([...lines.get("src/invoices/totals.ts")!.keys()]).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("builds inline comments for findings on the diff and lists the rest in the body", () => {
    const payload = buildReviewPayload(
      [
        finding({
          severity: "High",
          tags: ["correctness", "data"],
          file: "src/export/csv.ts",
          lineStart: 13,
          lineEnd: 13,
          title: "toFixed rounds differently from round()",
          explanation: "`toFixed` uses binary floating point and can round 1.005 down.",
          suggestedFix: "Format the already rounded total with `round(total, 2).toFixed(2)`.",
        }),
        finding({
          file: "./src/invoices/totals.ts",
          lineStart: 4,
          lineEnd: 7,
          title: "Inline the temporary",
          explanation: "`total` is returned straight away.",
          tags: ["code-quality"],
        }),
        finding({
          severity: "Low",
          file: "src/invoices/totals.ts",
          lineStart: 40,
          lineEnd: 42,
          title: "vatOf ignores reduced rates",
          explanation: "Outside this change, but related.",
        }),
        finding({
          severity: "Low",
          title: "No changelog entry",
          explanation: "Billing changes are listed in CHANGELOG.md.",
        }),
      ],
      {
        diff: DIFF,
        commitId: "9f1c2d3e4b5a69788796a5b4c3d2e1f009182736",
        summary: "Reviewed by blackwall.",
      },
    );
    expect(payload).toEqual({
      commit_id: "9f1c2d3e4b5a69788796a5b4c3d2e1f009182736",
      event: "COMMENT",
      body: [
        "Reviewed by blackwall.",
        "",
        "Findings outside the diff:",
        "",
        "- **[Low] vatOf ignores reduced rates** (`src/invoices/totals.ts:40-42`): Outside this change, but related.",
        "- **[Low] No changelog entry**: Billing changes are listed in CHANGELOG.md.",
      ].join("\n"),
      comments: [
        {
          path: "src/export/csv.ts",
          line: 13,
          side: "RIGHT",
          body: [
            "**[High] toFixed rounds differently from round()**",
            "",
            "`toFixed` uses binary floating point and can round 1.005 down.",
            "",
            "**Suggested fix:** Format the already rounded total with `round(total, 2).toFixed(2)`.",
            "",
            "`correctness` `data`",
          ].join("\n"),
        },
        {
          path: "src/invoices/totals.ts",
          line: 7,
          side: "RIGHT",
          start_line: 4,
          start_side: "RIGHT",
          body: [
            "**[Medium] Inline the temporary**",
            "",
            "`total` is returned straight away.",
            "",
            "`code-quality`",
          ].join("\n"),
        },
      ],
    });
  });

  it("posts the payload as a review", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json('{"id":77,"html_url":"https://acme.ghe.com/acme/shop/pull/42"}')),
    );
    const payload = buildReviewPayload([], { diff: DIFF });
    expect(payload).toEqual({ event: "COMMENT", body: "No findings.", comments: [] });
    const posted = await createGitHubClient(GHE, fetchImpl).createReview(PR, payload);
    expect(posted.id).toBe(77);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.acme.ghe.com/repos/acme/shop/pulls/42/reviews");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
  });
});

describe("signComment", () => {
  it("appends the signature below a rule", () => {
    expect(signComment("Summary")).toBe(`Summary\n\n---\n${COMMENT_SIGNATURE}`);
    expect(COMMENT_SIGNATURE).toBe("_Posted from blackwall_");
  });

  it("trims trailing whitespace first", () => {
    expect(signComment("Summary\n\n  \n")).toBe(`Summary\n\n---\n${COMMENT_SIGNATURE}`);
  });

  it("does not sign a body twice", () => {
    const signed = signComment("Summary");
    expect(signComment(signed)).toBe(signed);
    expect(signComment(`${signed}\n`)).toBe(signed);
  });

  it("signs an empty body", () => {
    expect(signComment("  ")).toBe(`---\n${COMMENT_SIGNATURE}`);
  });
});
