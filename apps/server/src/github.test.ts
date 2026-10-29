import { CiRateLimitedError, MissingCredentialError } from "@blackwall/core";
import type {
  AssignedIssues,
  Connection,
  ConnectionView,
  Finding,
  IssueLookup,
  PullRequestLookup,
  RepoIssues,
  ReviewRequests,
  Task,
} from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubOrigin,
  createRepoIssueSource,
  firstBranchFor,
  firstOriginContext,
  issueRoutes,
  pullRequestRoutes,
  type IssueRoutesOptions,
  type PullRequestRoutesOptions,
} from "./github.js";

const TOKEN = "ghp_secret_token";

const ghe: Connection = {
  id: "g1",
  name: "acme",
  kind: "github",
  baseUrl: "https://acme.ghe.com",
  authMeta: {},
  tokenSet: true,
} as Connection;

function connections(list: Connection[]) {
  const credential = (connection: Connection | undefined) => {
    if (!connection) throw new Error("no connection");
    return { connection, token: TOKEN };
  };
  return {
    list: () => list.map((c) => ({ ...c, hasToken: true }) as unknown as ConnectionView),
    credentialById: vi.fn(async (id: string) => credential(list.find((c) => c.id === id))),
    requireCredential: vi.fn(async ({ remote }: { kind: "github"; remote: string }) =>
      credential(list.find((c) => remote.startsWith(c.baseUrl))),
    ),
  };
}

const prTask = (connectionId: string | null) =>
  ({
    id: "t1",
    title: "Round invoice totals once",
    origin: {
      kind: "github-pr",
      url: "https://acme.ghe.com/acme/shop/pull/42",
      owner: "acme",
      repo: "shop",
      number: 42,
      connectionId,
    },
    baseBranch: null,
    worktreePath: null,
  }) as Task;

function fakeGitHub(headRepo = "acme/shop") {
  return vi.fn<typeof fetch>((input, init) => {
    const path = new URL(String(input)).pathname;
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (path === "/repos/acme/shop/pulls/42") {
      if (accept.includes("diff")) {
        return Promise.resolve(
          new Response("diff --git a/x b/x\n", { headers: { "content-type": "text/plain" } }),
        );
      }
      return Promise.resolve(
        json({
          number: 42,
          html_url: "https://acme.ghe.com/acme/shop/pull/42",
          title: "Round invoice totals once",
          body: "Fixes rounding.",
          state: "open",
          head: { ref: "fix/abc-123-rounding", sha: "abc", repo: { full_name: headRepo } },
          base: { ref: "main", sha: "def", repo: { full_name: "acme/shop" } },
        }),
      );
    }
    return Promise.resolve(json([]));
  });
}

describe("createGitHubOrigin", () => {
  it("checks out the PR head branch, resolving the connection from the PR host", async () => {
    const list = connections([ghe]);
    const fetchImpl = fakeGitHub();
    const github = createGitHubOrigin({ connections: list, fetch: fetchImpl });
    expect(await github.branchFor(prTask(null))).toBe("fix/abc-123-rounding");
    expect(list.requireCredential).toHaveBeenCalledWith({
      kind: "github",
      remote: "https://acme.ghe.com/acme/shop/pull/42",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.acme.ghe.com/repos/acme/shop/pulls/42");
    expect(new Headers(init?.headers).get("authorization")).toBe(`token ${TOKEN}`);
  });

  it("reads the PR's base branch", async () => {
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    expect(await github.baseBranchFor(prTask("g1"))).toBe("main");
  });

  it("refuses PRs from forks", async () => {
    const github = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeGitHub("someone/shop"),
    });
    await expect(github.branchFor(prTask("g1"))).rejects.toThrow(/fork someone\/shop/);
  });

  it("renders the PR as Inform context, naming a Jira key when no Jira site exists", async () => {
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    const context = await github.originContext(prTask("g1"), new AbortController().signal);
    expect(context).toContain("## Pull request acme/shop#42: Round invoice totals once");
    expect(context).toContain("Fixes rounding.");
    expect(context).toContain("Jira issue ABC-123; no Jira connection");
  });

  it("leaves other origins to other hooks", async () => {
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    const signal = new AbortController().signal;
    expect(await github.branchFor(freeText)).toBeUndefined();
    expect(await github.baseBranchFor(freeText)).toBeUndefined();
    expect(await github.originContext(freeText, signal)).toBeUndefined();
    const other = async () => "agent/t1";
    expect(await firstBranchFor(github.branchFor, other)(freeText)).toBe("agent/t1");
    expect(await firstOriginContext(github.originContext)(freeText, signal)).toBeUndefined();
  });
});

/** acme/shop's open PRs #41 ← #42 ← #43 (each based on the one below), with their diffs. */
function fakeStack() {
  const prs = [
    { number: 41, head: "b41", base: "main" },
    { number: 42, head: "b42", base: "b41" },
    { number: 43, head: "b43", base: "b42" },
  ];
  const toJson = (pr: (typeof prs)[number]) => ({
    number: pr.number,
    html_url: `https://acme.ghe.com/acme/shop/pull/${pr.number}`,
    title: `PR ${pr.number}`,
    state: "open",
    head: { ref: pr.head, sha: "a", repo: { full_name: "acme/shop" } },
    base: { ref: pr.base, sha: "b", repo: { full_name: "acme/shop", default_branch: "main" } },
  });
  return vi.fn<typeof fetch>((input, init) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    const one = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(url.pathname);
    const pr = one && prs.find((p) => p.number === Number(one[1]));
    if (pr) {
      return Promise.resolve(
        accept.includes("diff")
          ? new Response(`diff --git a/pr${pr.number} b/pr${pr.number}\n`, {
              headers: { "content-type": "text/plain" },
            })
          : json(toJson(pr)),
      );
    }
    if (url.pathname === "/repos/acme/shop/pulls") {
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      return Promise.resolve(
        json(
          prs
            .filter(
              (p) =>
                (head === null || head === `acme:${p.head}`) && (base === null || base === p.base),
            )
            .map(toJson),
        ),
      );
    }
    return Promise.resolve(json([]));
  });
}

/** Stubs the PR's comment endpoints on the GHE host; `status` fails the review comments call. */
function fakeComments({
  reviewComments = [],
  issueComments = [],
  reviews = [],
  status = 200,
}: {
  reviewComments?: unknown[];
  issueComments?: unknown[];
  reviews?: unknown[];
  status?: number;
} = {}) {
  return vi.fn<typeof fetch>((input) => {
    const path = new URL(String(input)).pathname;
    const isReviewComments = path === "/repos/acme/shop/pulls/42/comments";
    const body = isReviewComments
      ? status === 200
        ? reviewComments
        : { message: "Resource not accessible by integration" }
      : path === "/repos/acme/shop/issues/42/comments"
        ? issueComments
        : path === "/repos/acme/shop/pulls/42/reviews"
          ? reviews
          : [];
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: isReviewComments ? status : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
}

describe("prBranchOwned", () => {
  const signal = () => new AbortController().signal;

  /** Answers the viewer, the PR (from `arve` on the shop repo) and its commits. */
  function fakeOwnership({
    login = "arve",
    prAuthor = "arve",
    headRepo = "acme/shop",
    commits = [{ sha: "a1", author: { login: "arve" } }],
  }: {
    login?: string;
    prAuthor?: string;
    headRepo?: string | null;
    commits?: { sha: string; author: { login: string } | null }[];
  } = {}) {
    return vi.fn<typeof fetch>((input) => {
      const path = new URL(String(input)).pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (path === "/user") return Promise.resolve(json({ login }));
      if (path === "/repos/acme/shop/pulls/42") {
        return Promise.resolve(
          json({
            number: 42,
            html_url: "https://acme.ghe.com/acme/shop/pull/42",
            title: "Round invoice totals once",
            state: "open",
            user: { login: prAuthor },
            head: {
              ref: "fix/abc-123-rounding",
              sha: "abc",
              repo: headRepo === null ? null : { full_name: headRepo },
            },
            base: { ref: "main", sha: "def", repo: { full_name: "acme/shop" } },
          }),
        );
      }
      if (path === "/repos/acme/shop/pulls/42/commits") return Promise.resolve(json(commits));
      return Promise.resolve(json([]));
    });
  }

  it("is true when the PR and every commit on its branch are the user's own", async () => {
    const fetchImpl = fakeOwnership();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    expect(await github.prBranchOwned(prTask("g1"), signal())).toBe(true);
    const paths = fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/user",
        "/repos/acme/shop/pulls/42",
        "/repos/acme/shop/pulls/42/commits",
      ]),
    );
  });

  it("is false when a commit on the branch is by someone else", async () => {
    const commits = [
      { sha: "a1", author: { login: "arve" } },
      { sha: "a2", author: { login: "kari" } },
    ];
    const github = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeOwnership({ commits }),
    });
    expect(await github.prBranchOwned(prTask("g1"), signal())).toBe(false);
  });

  it("throws for a task that is not a pull request, or without a connection", async () => {
    const list = connections([ghe]);
    const github = createGitHubOrigin({ connections: list, fetch: fakeOwnership() });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    await expect(github.prBranchOwned(freeText, signal())).rejects.toThrow(/has no pull request/);

    list.requireCredential.mockRejectedValueOnce(
      new MissingCredentialError("github", "acme.ghe.com", null),
    );
    await expect(github.prBranchOwned(prTask(null), signal())).rejects.toThrow(
      MissingCredentialError,
    );
  });

  it("throws when the signal is already aborted", async () => {
    const fetchImpl = fakeOwnership();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(github.prBranchOwned(prTask("g1"), controller.signal)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pullRequestMergeState", () => {
  const signal = () => new AbortController().signal;

  function fakePr(pr: { state: string; merged?: boolean; base?: string }) {
    return vi.fn<typeof fetch>((input) => {
      const path = new URL(String(input)).pathname;
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (path === "/repos/acme/shop/pulls/42") {
        return Promise.resolve(
          json({
            number: 42,
            html_url: "https://acme.ghe.com/acme/shop/pull/42",
            title: "Round invoice totals once",
            state: pr.state,
            ...(pr.merged === undefined ? {} : { merged: pr.merged }),
            head: { ref: "fix/abc-123-rounding", sha: "abc" },
            base: { ref: pr.base ?? "main", sha: "def" },
          }),
        );
      }
      return Promise.resolve(json([]));
    });
  }

  it("reports an open, a merged and a closed unmerged pull request", async () => {
    const cases = [
      [{ state: "open" }, { state: "open", merged: false, baseRef: "main" }],
      [
        { state: "closed", merged: true, base: "develop" },
        { state: "closed", merged: true, baseRef: "develop" },
      ],
      [
        { state: "closed", merged: false },
        { state: "closed", merged: false, baseRef: "main" },
      ],
    ] as const;
    for (const [pr, expected] of cases) {
      const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakePr(pr) });
      expect(await github.pullRequestMergeState(prTask("g1"), signal())).toEqual(expected);
    }
  });

  it("throws for a task that is not a pull request, or without a token", async () => {
    const list = connections([ghe]);
    const github = createGitHubOrigin({ connections: list, fetch: fakePr({ state: "open" }) });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    await expect(github.pullRequestMergeState(freeText, signal())).rejects.toThrow(
      /has no pull request/,
    );
    list.requireCredential.mockRejectedValueOnce(
      new MissingCredentialError("github", "acme.ghe.com", null),
    );
    await expect(github.pullRequestMergeState(prTask(null), signal())).rejects.toThrow(
      MissingCredentialError,
    );
  });
});

describe("pullRequestComments", () => {
  const rootComment = {
    id: 101,
    path: "src/money.ts",
    line: 12,
    original_line: 12,
    start_line: 10,
    side: "RIGHT",
    body: " Round before summing? ",
    user: { login: "kari" },
    created_at: "2026-10-01T09:00:00Z",
    diff_hunk: "@@ -10,3 +10,3 @@",
    html_url: "https://acme.ghe.com/acme/shop/pull/42#discussion_r101",
  };
  const reply = {
    id: 102,
    path: "src/money.ts",
    line: 12,
    original_line: 12,
    start_line: 10,
    side: "RIGHT",
    body: "Done.",
    user: { login: "ola" },
    created_at: "2026-10-01T10:00:00Z",
    in_reply_to_id: 101,
    html_url: "https://acme.ghe.com/acme/shop/pull/42#discussion_r102",
  };
  const outdatedRoot = {
    id: 201,
    path: "src/tax.ts",
    line: null,
    original_line: 5,
    start_line: null,
    side: "LEFT",
    body: "Old note",
    user: { login: "kari" },
    created_at: "2026-09-30T08:00:00Z",
    diff_hunk: "@@ -5 +5 @@",
    html_url: "https://acme.ghe.com/acme/shop/pull/42#discussion_r201",
  };

  it("maps the PR's review threads, replies under their root, outdated threads included", async () => {
    const fetchImpl = fakeComments({ reviewComments: [reply, rootComment, outdatedRoot] });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const result = await github.pullRequestComments(prTask("g1"));

    expect(result).toEqual({
      error: null,
      threads: [
        {
          id: 201,
          path: "src/tax.ts",
          line: null,
          startLine: null,
          side: "LEFT",
          outdated: true,
          url: "https://acme.ghe.com/acme/shop/pull/42#discussion_r201",
          comments: [
            {
              id: 201,
              author: "kari",
              body: "Old note",
              createdAt: new Date("2026-09-30T08:00:00Z"),
            },
          ],
        },
        {
          id: 101,
          path: "src/money.ts",
          line: 12,
          startLine: 10,
          side: "RIGHT",
          outdated: false,
          url: "https://acme.ghe.com/acme/shop/pull/42#discussion_r101",
          comments: [
            {
              id: 101,
              author: "kari",
              body: "Round before summing?",
              createdAt: new Date("2026-10-01T09:00:00Z"),
            },
            {
              id: 102,
              author: "ola",
              body: "Done.",
              createdAt: new Date("2026-10-01T10:00:00Z"),
            },
          ],
        },
      ],
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).host).toBe("api.acme.ghe.com");
    expect(new URL(String(url)).pathname).toBe("/repos/acme/shop/pulls/42/comments");
  });

  it("gives no threads for a task that is not a PR", async () => {
    const fetchImpl = fakeComments({ reviewComments: [rootComment] });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    expect(await github.pullRequestComments(freeText)).toEqual({ threads: [], error: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing token as an error instead of throwing", async () => {
    const list = connections([ghe]);
    list.requireCredential.mockRejectedValueOnce(
      new MissingCredentialError("github", "acme.ghe.com", null),
    );
    const fetchImpl = fakeComments({ reviewComments: [rootComment] });
    const github = createGitHubOrigin({ connections: list, fetch: fetchImpl });
    const result = await github.pullRequestComments(prTask(null));
    expect(result.threads).toEqual([]);
    expect(result.error).toContain("No GitHub token for acme.ghe.com");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a GitHub failure as an error instead of throwing", async () => {
    const fetchImpl = fakeComments({ status: 403 });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const result = await github.pullRequestComments(prTask("g1"));
    expect(result.threads).toEqual([]);
    expect(typeof result.error).toBe("string");
    expect(result.error).not.toBeNull();
    expect(result.error).not.toContain(TOKEN);
  });
});

describe("prCommentsContext", () => {
  const signal = new AbortController().signal;

  it("renders the conversation, review summaries and inline threads as Code review context", async () => {
    const fetchImpl = fakeComments({
      reviewComments: [
        {
          id: 101,
          path: "src/money.ts",
          line: 12,
          side: "RIGHT",
          body: "Round before summing?",
          user: { login: "kari" },
          created_at: "2026-10-01T09:00:00Z",
          diff_hunk: "@@ -10,3 +10,3 @@",
        },
      ],
      issueComments: [
        {
          id: 301,
          body: "Can we also cover refunds?",
          user: { login: "dev" },
          created_at: "2026-10-02T00:00:00Z",
        },
      ],
      reviews: [
        {
          id: 401,
          state: "CHANGES_REQUESTED",
          body: "Please fix the rounding.",
          user: { login: "kari" },
          submitted_at: "2026-10-02T12:00:00Z",
        },
      ],
    });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const context = await github.prCommentsContext(prTask("g1"), signal);
    expect(context).toContain("### Conversation");
    expect(context).toContain("### Review comments");
    expect(context).toContain("Can we also cover refunds?");
    expect(context).toContain("Please fix the rounding.");
    expect(context).toContain("[review: changes_requested]");
    expect(context).toContain("src/money.ts:12");
    expect(context).toContain("Round before summing?");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives no context when the PR has no comments", async () => {
    const github = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeComments(),
    });
    expect(await github.prCommentsContext(prTask("g1"), signal)).toBeUndefined();
  });

  it("gives no context for other tasks", async () => {
    const fetchImpl = fakeComments({
      issueComments: [{ id: 1, body: "hi", user: { login: "a" } }],
    });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    expect(await github.prCommentsContext(freeText, signal)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pullRequestFeedback", () => {
  const PR = "https://acme.ghe.com/acme/shop/pull/42";
  const signed = "Fixed in abc.\n\n---\n_Posted from blackwall_";

  it("reads every thread and the conversation with permalinks, minus blackwall's comments", async () => {
    const list = connections([ghe]);
    const fetchImpl = fakeComments({
      reviewComments: [
        {
          id: 101,
          path: "src/money.ts",
          line: 12,
          original_line: 12,
          start_line: 10,
          side: "RIGHT",
          body: "Round before summing?",
          user: { login: "kari" },
          created_at: "2026-10-01T09:00:00Z",
          diff_hunk: "@@ -10,3 +10,3 @@",
        },
        {
          id: 102,
          path: "src/money.ts",
          line: 12,
          side: "RIGHT",
          body: signed,
          user: { login: "ola" },
          created_at: "2026-10-01T10:00:00Z",
          in_reply_to_id: 101,
        },
        {
          id: 201,
          path: "src/tax.ts",
          line: null,
          original_line: 5,
          start_line: null,
          side: "LEFT",
          body: "Old note",
          user: { login: "kari" },
          created_at: "2026-09-30T08:00:00Z",
          diff_hunk: "@@ -5 +5 @@",
        },
        {
          id: 301,
          path: "src/x.ts",
          line: 1,
          side: "RIGHT",
          body: signed,
          user: { login: "ola" },
          created_at: "2026-10-01T11:00:00Z",
        },
      ],
      issueComments: [
        { id: 501, body: "Cover refunds?", user: { login: "dev" }, created_at: "2026-10-02" },
        { id: 502, body: signed, user: { login: "ola" }, created_at: "2026-10-03" },
      ],
      reviews: [
        {
          id: 601,
          state: "CHANGES_REQUESTED",
          body: "Please fix the rounding.",
          user: { login: "kari" },
          submitted_at: "2026-10-04T00:00:00Z",
        },
      ],
    });
    const github = createGitHubOrigin({ connections: list, fetch: fetchImpl });

    expect(await github.pullRequestFeedback(`${PR}/files`)).toEqual({
      threads: [
        {
          path: "src/tax.ts",
          line: null,
          startLine: null,
          originalLine: 5,
          side: "LEFT",
          outdated: true,
          url: `${PR}#discussion_r201`,
          diffHunk: "@@ -5 +5 @@",
          comments: [{ url: `${PR}#discussion_r201`, author: "kari", body: "Old note" }],
        },
        {
          path: "src/money.ts",
          line: 12,
          startLine: 10,
          originalLine: 12,
          side: "RIGHT",
          outdated: false,
          url: `${PR}#discussion_r101`,
          diffHunk: "@@ -10,3 +10,3 @@",
          comments: [
            { url: `${PR}#discussion_r101`, author: "kari", body: "Round before summing?" },
          ],
        },
      ],
      conversation: [
        { url: `${PR}#issuecomment-501`, author: "dev", body: "Cover refunds?" },
        {
          url: `${PR}#pullrequestreview-601`,
          author: "kari",
          body: "Please fix the rounding.",
          reviewState: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(list.requireCredential).toHaveBeenCalledWith({ kind: "github", remote: `${PR}/files` });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).host).toBe("api.acme.ghe.com");
  });

  it("throws a missing token, so the token modal can ask for one", async () => {
    const list = connections([ghe]);
    list.requireCredential.mockRejectedValueOnce(
      new MissingCredentialError("github", "acme.ghe.com", null),
    );
    const github = createGitHubOrigin({ connections: list, fetch: fakeComments() });
    await expect(github.pullRequestFeedback(PR)).rejects.toThrow(MissingCredentialError);
  });
});

describe("stacked pull requests", () => {
  const signal = new AbortController().signal;

  it("finds the PR's stack, bottom first, or nothing when it is not stacked", async () => {
    const origin = prTask("g1").origin as Extract<Task["origin"], { kind: "github-pr" }>;
    const stacked = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeStack() });
    const members = await stacked.pullRequestStack(origin);
    expect(members?.map((m) => m.number)).toEqual([41, 42, 43]);

    const alone = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    expect(await alone.pullRequestStack(origin)).toBeUndefined();
  });

  it("renders the other PRs' diffs as Code review context", async () => {
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeStack() });
    const context = await github.stackContext(prTask("g1"), signal);
    expect(context).toContain("2. #42: PR 42 (b42 → b41) ← this PR");
    expect(context).toContain("### #41: PR 41 (b41 → main), below this PR");
    expect(context).toContain("a/pr41");
    expect(context).toContain("### #43: PR 43 (b43 → b42), above this PR");
    expect(context).toContain("a/pr43");
    expect(context).not.toContain("a/pr42");
  });

  it("gives no context for other tasks or PRs that are not stacked", async () => {
    const alone = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    expect(await alone.stackContext(prTask("g1"), signal)).toBeUndefined();
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    expect(await alone.stackContext(freeText, signal)).toBeUndefined();
  });
});

const issueOrigin = {
  kind: "github-issue" as const,
  url: "https://acme.ghe.com/acme/shop/issues/7",
  owner: "acme",
  repo: "shop",
  number: 7,
  connectionId: null,
};

const issueTask = () =>
  ({
    id: "t2",
    title: "Export",
    origin: issueOrigin,
    baseBranch: null,
    worktreePath: null,
  }) as Task;

/** Answers for issue 7 (labelled `labels`), its comments, and issue 42, which is a PR. */
function fakeIssues(labels: string[] = []) {
  const writes: { path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>((input, init) => {
    const path = new URL(String(input)).pathname;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return Promise.resolve(
        json({ id: 1, html_url: "https://acme.ghe.com/acme/shop/issues/7#issuecomment-1" }, 201),
      );
    }
    if (path === "/repos/acme/shop/issues/7") {
      return Promise.resolve(
        json({
          number: 7,
          html_url: "https://acme.ghe.com/acme/shop/issues/7",
          title: "Export drops the last row",
          body: "The CSV misses a line.",
          state: "open",
          labels: labels.map((name) => ({ name })),
        }),
      );
    }
    if (path === "/repos/acme/shop/issues/42") {
      return Promise.resolve(
        json({ number: 42, html_url: "", title: "A PR", state: "open", pull_request: {} }),
      );
    }
    return Promise.resolve(json([]));
  });
  return { fetchImpl, writes };
}

describe("GitHub issue origin", () => {
  it("names a new branch from the issue, fix/ for a bug label", async () => {
    const feature = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeIssues(["enhancement"]).fetchImpl,
    });
    expect(await feature.branchFor(issueTask())).toBe("feature/7-export-drops-the-last-row");
    const fix = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeIssues(["BUG"]).fetchImpl,
    });
    expect(await fix.branchFor(issueTask())).toBe("fix/7-export-drops-the-last-row");
  });

  it("titles the task from the issue and renders it as Inform context", async () => {
    const github = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeIssues().fetchImpl,
    });
    expect(await github.titleFor(issueOrigin)).toBe("Export drops the last row");
    const context = await github.originContext(issueTask(), new AbortController().signal);
    expect(context).toContain("## Issue acme/shop#7: Export drops the last row");
    expect(context).toContain("The CSV misses a line.");
  });

  it("refuses an issue link that is really a pull request", async () => {
    const github = createGitHubOrigin({
      connections: connections([ghe]),
      fetch: fakeIssues().fetchImpl,
    });
    const pr = { ...issueOrigin, url: "https://acme.ghe.com/acme/shop/issues/42", number: 42 };
    await expect(github.titleFor(pr)).rejects.toThrow(
      "acme/shop#42 is a pull request; use the GitHub PR origin",
    );
    await expect(github.branchFor({ ...issueTask(), origin: pr })).rejects.toThrow(
      /is a pull request/,
    );
  });

  it("comments on the issue, signed, for a task or a bare origin", async () => {
    const { fetchImpl, writes } = fakeIssues();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    expect(await github.commentOnIssue(issueTask(), "Plan approved.")).toEqual({
      url: "https://acme.ghe.com/acme/shop/issues/7#issuecomment-1",
    });
    await github.commentOnIssue(issueOrigin, "Work started.");
    expect(writes).toEqual([
      {
        path: "/repos/acme/shop/issues/7/comments",
        body: { body: "Plan approved.\n\n---\n_Posted from blackwall_" },
      },
      {
        path: "/repos/acme/shop/issues/7/comments",
        body: { body: "Work started.\n\n---\n_Posted from blackwall_" },
      },
    ]);
    await expect(github.commentOnIssue(prTask("g1"), "x")).rejects.toThrow(/no GitHub issue/);
  });

  it("surfaces a missing token so the token modal can ask for one", async () => {
    const list = connections([ghe]);
    list.requireCredential.mockRejectedValue(
      new MissingCredentialError("github", "acme.ghe.com", null),
    );
    const github = createGitHubOrigin({ connections: list, fetch: fakeIssues().fetchImpl });
    await expect(github.titleFor(issueOrigin)).rejects.toThrow(MissingCredentialError);
    await expect(github.commentOnIssue(issueOrigin, "x")).rejects.toThrow(MissingCredentialError);
    await expect(github.assignIssue(issueOrigin)).rejects.toThrow(MissingCredentialError);
  });

  it("assigns the issue to the token's user", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const path = new URL(String(input)).pathname;
      const body = path === "/user" ? { login: "kari" } : { number: 7 };
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
    });
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    expect(await github.assignIssue(issueOrigin)).toEqual({ login: "kari" });
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(new URL(String(url)).pathname).toBe("/repos/acme/shop/issues/7/assignees");
    expect(JSON.parse(String(init?.body))).toEqual({ assignees: ["kari"] });
  });
});

describe("issueRoutes", () => {
  const routes = issueRoutes({
    connections: {
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("acme.ghe.com")
          ? ghe
          : undefined,
      list: () => [],
      credentialById: () => Promise.reject(new Error("no connection")),
    },
    repos: {
      list: () =>
        [
          { id: "r1", remoteUrl: "git@acme.ghe.com:acme/shop.git" },
          { id: "r2", remoteUrl: null },
        ] as never,
    },
  });
  const lookup = (url: unknown) =>
    routes.request("/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });

  it("resolves an issue link to its origin, connection and registered repo", async () => {
    const res = await lookup("https://acme.ghe.com/acme/shop/issues/7/");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual<IssueLookup>({
      origin: { ...issueOrigin, connectionId: "g1" },
      repoId: "r1",
    });
  });

  it("returns no repo or connection when they are missing, so the user picks", async () => {
    const res = await lookup("https://github.com/acme/other/issues/1");
    expect(await res.json()).toMatchObject({ origin: { connectionId: null }, repoId: null });
  });

  it("rejects links that are not issues", async () => {
    expect((await lookup("https://github.com/acme/shop/pull/1")).status).toBe(400);
    expect((await lookup(42)).status).toBe(400);
  });
});

describe("pullRequestRoutes", () => {
  const routes = pullRequestRoutes({
    connections: {
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("acme.ghe.com")
          ? ghe
          : undefined,
      list: () => [],
      credentialById: () => Promise.reject(new Error("no connection")),
    },
    repos: {
      list: () =>
        [
          { id: "r1", remoteUrl: "git@acme.ghe.com:acme/shop.git" },
          { id: "r2", remoteUrl: null },
        ] as never,
    },
  });
  const lookup = (url: unknown) =>
    routes.request("/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });

  it("resolves a PR link to its origin, connection and registered repo", async () => {
    const res = await lookup("https://acme.ghe.com/acme/shop/pull/42/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual<PullRequestLookup>({
      origin: {
        kind: "github-pr",
        url: "https://acme.ghe.com/acme/shop/pull/42",
        owner: "acme",
        repo: "shop",
        number: 42,
        connectionId: "g1",
      },
      repoId: "r1",
    });
  });

  it("returns no repo or connection when they are missing, so the form can ask", async () => {
    const res = await lookup("https://github.com/acme/other/pull/1");
    expect(await res.json()).toMatchObject({ origin: { connectionId: null }, repoId: null });
  });

  it("rejects links that are not pull requests", async () => {
    expect((await lookup("https://github.com/acme/shop/issues/1")).status).toBe(400);
    expect((await lookup(42)).status).toBe(400);
  });
});

describe("review requests route", () => {
  const conn = (id: string, kind: Connection["kind"], baseUrl: string, hasToken = true) =>
    ({ id, name: id, kind, baseUrl, authMeta: {}, hasToken }) as unknown as ConnectionView;
  const node = (host: string, number: number, updatedAt: string) => ({
    url: `https://${host}/acme/shop/pull/${number}`,
    number,
    title: `PR ${number}`,
    updatedAt,
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    author: { login: "kari" },
    repository: { name: "shop", owner: { login: "acme" } },
  });

  function setup(
    list: ConnectionView[],
    fail: string[] = [],
    {
      repos = [],
      resolve = () => undefined,
    }: {
      repos?: { id: string; remoteUrl: string | null }[];
      resolve?: PullRequestRoutesOptions["connections"]["resolve"];
    } = {},
  ) {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(String(input));
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (fail.includes(url.host))
        return Promise.resolve(json({ message: "Bad credentials" }, 401));
      const nodes =
        url.host === "api.github.com"
          ? [node("github.com", 1, "2026-10-01T10:00:00Z")]
          : [
              node("acme.ghe.com", 2, "2026-10-03T10:00:00Z"),
              node("acme.ghe.com", 3, "2026-09-30T10:00:00Z"),
            ];
      return Promise.resolve(json({ data: { search: { nodes } } }));
    });
    const credentialById = vi.fn(async (id: string) => ({
      connection: list.find((c) => c.id === id) as unknown as Connection,
      token: TOKEN,
    }));
    const routes = pullRequestRoutes({
      connections: { resolve, list: () => list, credentialById },
      repos: { list: () => repos as never },
      fetch: fetchImpl,
    });
    return { routes, fetchImpl, credentialById };
  }

  const github = conn("c1", "github", "https://github.com");
  const acme = conn("c2", "github", "https://acme.ghe.com");

  it("merges every GitHub host's PRs, newest first", async () => {
    const { routes } = setup([github, acme]);
    const res = await routes.request("/review-requests");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewRequests;
    expect(body.errors).toEqual([]);
    expect(body.pullRequests.map((pr) => [pr.host, pr.number])).toEqual([
      ["acme.ghe.com", 2],
      ["github.com", 1],
      ["acme.ghe.com", 3],
    ]);
    expect(body.pullRequests[0]).toMatchObject({
      owner: "acme",
      repo: "shop",
      url: "https://acme.ghe.com/acme/shop/pull/2",
      author: "kari",
      updatedAt: "2026-10-03T10:00:00.000Z",
      reviewDecision: "review-required",
      repoId: null,
      connectionId: null,
    });
  });

  it("adds the registered repo and the host's connection to each PR", async () => {
    const { routes } = setup([github, acme], [], {
      repos: [
        { id: "r1", remoteUrl: "git@acme.ghe.com:acme/shop.git" },
        { id: "r2", remoteUrl: null },
      ],
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("acme.ghe.com")
          ? acme
          : github,
    });
    const body = (await (await routes.request("/review-requests")).json()) as ReviewRequests;
    expect(body.pullRequests.map((pr) => [pr.host, pr.number, pr.repoId, pr.connectionId])).toEqual(
      [
        ["acme.ghe.com", 2, "r1", "c2"],
        ["github.com", 1, null, "c1"],
        ["acme.ghe.com", 3, "r1", "c2"],
      ],
    );
  });

  it("skips Jira connections and GitHub connections without a token", async () => {
    const { routes, fetchImpl, credentialById } = setup([
      github,
      conn("j1", "jira", "https://acme.atlassian.net"),
      conn("c3", "github", "https://other.ghe.com", false),
    ]);
    const body = (await (await routes.request("/review-requests")).json()) as ReviewRequests;
    expect(body.pullRequests).toHaveLength(1);
    expect(credentialById.mock.calls).toEqual([["c1"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lists a failing host in errors and still returns the others", async () => {
    const { routes } = setup([github, acme], ["api.acme.ghe.com"]);
    const res = await routes.request("/review-requests");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReviewRequests;
    expect(body.pullRequests.map((pr) => pr.number)).toEqual([1]);
    expect(body.errors).toEqual([
      { host: "acme.ghe.com", message: "acme.ghe.com: token rejected" },
    ]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("returns nothing without connections", async () => {
    const res = await setup([]).routes.request("/review-requests");
    expect(await res.json()).toEqual({ pullRequests: [], errors: [] });
  });
});

describe("assigned issues route", () => {
  const conn = (id: string, kind: Connection["kind"], baseUrl: string, hasToken = true) =>
    ({ id, name: id, kind, baseUrl, authMeta: {}, hasToken }) as unknown as ConnectionView;
  const node = (host: string, number: number, updatedAt: string) => ({
    url: `https://${host}/acme/shop/issues/${number}`,
    number,
    title: `Issue ${number}`,
    updatedAt,
    author: { login: "kari" },
    repository: { name: "shop", owner: { login: "acme" } },
  });

  function setup(
    list: ConnectionView[],
    fail: string[] = [],
    {
      repos = [],
      resolve = () => undefined,
    }: {
      repos?: { id: string; remoteUrl: string | null }[];
      resolve?: IssueRoutesOptions["connections"]["resolve"];
    } = {},
  ) {
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      const url = new URL(String(input));
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (fail.includes(url.host))
        return Promise.resolve(json({ message: "Bad credentials" }, 401));
      const nodes =
        url.host === "api.github.com"
          ? [node("github.com", 1, "2026-10-01T10:00:00Z")]
          : [
              node("acme.ghe.com", 2, "2026-10-03T10:00:00Z"),
              node("acme.ghe.com", 3, "2026-09-30T10:00:00Z"),
            ];
      return Promise.resolve(json({ data: { search: { nodes } } }));
    });
    const credentialById = vi.fn(async (id: string) => ({
      connection: list.find((c) => c.id === id) as unknown as Connection,
      token: TOKEN,
    }));
    const routes = issueRoutes({
      connections: { resolve, list: () => list, credentialById },
      repos: { list: () => repos as never },
      fetch: fetchImpl,
    });
    return { routes, fetchImpl, credentialById };
  }

  const github = conn("c1", "github", "https://github.com");
  const acme = conn("c2", "github", "https://acme.ghe.com");

  it("merges every GitHub host's issues, newest first", async () => {
    const { routes } = setup([github, acme]);
    const res = await routes.request("/assigned");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AssignedIssues;
    expect(body.errors).toEqual([]);
    expect(body.issues.map((issue) => [issue.host, issue.number])).toEqual([
      ["acme.ghe.com", 2],
      ["github.com", 1],
      ["acme.ghe.com", 3],
    ]);
    expect(body.issues[0]).toEqual({
      host: "acme.ghe.com",
      owner: "acme",
      repo: "shop",
      number: 2,
      title: "Issue 2",
      url: "https://acme.ghe.com/acme/shop/issues/2",
      author: "kari",
      updatedAt: "2026-10-03T10:00:00.000Z",
      repoId: null,
      connectionId: null,
    });
  });

  it("adds the registered repo and the host's connection to each issue", async () => {
    const { routes } = setup([github, acme], [], {
      repos: [
        { id: "r1", remoteUrl: "git@acme.ghe.com:acme/shop.git" },
        { id: "r2", remoteUrl: null },
      ],
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("acme.ghe.com")
          ? acme
          : github,
    });
    const body = (await (await routes.request("/assigned")).json()) as AssignedIssues;
    expect(
      body.issues.map((issue) => [issue.host, issue.number, issue.repoId, issue.connectionId]),
    ).toEqual([
      ["acme.ghe.com", 2, "r1", "c2"],
      ["github.com", 1, null, "c1"],
      ["acme.ghe.com", 3, "r1", "c2"],
    ]);
  });

  it("skips Jira connections and GitHub connections without a token", async () => {
    const { routes, fetchImpl, credentialById } = setup([
      github,
      conn("j1", "jira", "https://acme.atlassian.net"),
      conn("c3", "github", "https://other.ghe.com", false),
    ]);
    const body = (await (await routes.request("/assigned")).json()) as AssignedIssues;
    expect(body.issues).toHaveLength(1);
    expect(credentialById.mock.calls).toEqual([["c1"]]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lists a failing host in errors and still returns the others", async () => {
    const { routes } = setup([github, acme], ["api.acme.ghe.com"]);
    const res = await routes.request("/assigned");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AssignedIssues;
    expect(body.issues.map((issue) => issue.number)).toEqual([1]);
    expect(body.errors).toEqual([
      { host: "acme.ghe.com", message: "acme.ghe.com: token rejected" },
    ]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("returns nothing without connections", async () => {
    const res = await setup([]).routes.request("/assigned");
    expect(await res.json()).toEqual({ issues: [], errors: [] });
  });
});

describe("repo issues route", () => {
  const conn = (id: string, kind: Connection["kind"], baseUrl: string, hasToken = true) =>
    ({ id, name: id, kind, baseUrl, authMeta: {}, hasToken }) as unknown as ConnectionView;
  const node = (number: number, updatedAt: string, assignees: string[]) => ({
    url: `https://acme.ghe.com/acme/shop/issues/${number}`,
    number,
    title: `Issue ${number}`,
    updatedAt,
    author: { login: "kari" },
    repository: { name: "shop", owner: { login: "acme" } },
    assignees: { nodes: assignees.map((login) => ({ login })) },
  });
  const repos = [
    { id: "r1", remoteUrl: "git@acme.ghe.com:acme/shop.git" },
    { id: "r2", remoteUrl: null },
    { id: "r3", remoteUrl: "https://gitlab.com/acme/shop.git" },
    { id: "r4", remoteUrl: "C:\\Code\\shop" },
  ];

  function setup(list: ConnectionView[], { fail = false } = {}) {
    const fetchImpl = vi.fn<typeof fetch>(() => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (fail) return Promise.resolve(json({ message: "Bad credentials" }, 401));
      const nodes = [
        node(1, "2026-09-30T10:00:00Z", []),
        node(2, "2026-10-03T10:00:00Z", ["ola"]),
        node(3, "2026-10-01T10:00:00Z", ["kari", "ola"]),
      ];
      return Promise.resolve(json({ data: { search: { nodes } } }));
    });
    const credentialById = vi.fn(async (id: string) => ({
      connection: list.find((c) => c.id === id) as unknown as Connection,
      token: TOKEN,
    }));
    const resolve: IssueRoutesOptions["connections"]["resolve"] = (target) =>
      list.find(
        (c) =>
          c.kind === target.kind &&
          "remote" in target &&
          target.remote.includes(new URL(c.baseUrl).host),
      ) as unknown as Connection | undefined;
    const routes = issueRoutes({
      connections: { resolve, list: () => list, credentialById },
      repos: { list: () => repos as never },
      fetch: fetchImpl,
    });
    return { routes, fetchImpl, credentialById };
  }

  const acme = conn("c2", "github", "https://acme.ghe.com");

  it("lists the repository's open issues, most recently updated first", async () => {
    const { routes, fetchImpl } = setup([acme]);
    const res = await routes.request("/repo/r1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoIssues;
    expect(body.errors).toEqual([]);
    expect(body.issues.map((issue) => [issue.number, issue.assignees])).toEqual([
      [2, ["ola"]],
      [3, ["kari", "ola"]],
      [1, []],
    ]);
    expect(body.issues[0]).toEqual({
      host: "acme.ghe.com",
      owner: "acme",
      repo: "shop",
      number: 2,
      title: "Issue 2",
      url: "https://acme.ghe.com/acme/shop/issues/2",
      author: "kari",
      updatedAt: "2026-10-03T10:00:00.000Z",
      assignees: ["ola"],
      repoId: "r1",
      connectionId: "c2",
    });
    const { variables } = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as {
      variables: { search: string };
    };
    expect(variables.search).toBe(
      "repo:acme/shop is:issue is:open archived:false sort:updated-desc",
    );
  });

  it("answers 404 for an unknown repo", async () => {
    const res = await setup([acme]).routes.request("/repo/nope");
    expect(res.status).toBe(404);
  });

  it("lists nothing, without asking GitHub, when the repo has no GitHub remote or token", async () => {
    for (const [list, repoId] of [
      [[acme], "r2"],
      [[acme], "r3"],
      [[acme], "r4"],
      [[conn("c2", "github", "https://acme.ghe.com", false)], "r1"],
      [[conn("j1", "jira", "https://acme.ghe.com")], "r1"],
    ] as const) {
      const { routes, fetchImpl, credentialById } = setup([...list]);
      const res = await routes.request(`/repo/${repoId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ issues: [], errors: [] });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(credentialById).not.toHaveBeenCalled();
    }
  });

  it("lists a host failure in errors", async () => {
    const res = await setup([acme], { fail: true }).routes.request("/repo/r1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RepoIssues;
    expect(body).toEqual({
      issues: [],
      errors: [{ host: "acme.ghe.com", message: "acme.ghe.com: token rejected" }],
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

describe("createRepoIssueSource", () => {
  it("looks up the token's user once per connection", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ login: "kari" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const source = createRepoIssueSource({
      connections: { ...connections([ghe]), resolve: () => undefined },
      fetch: fetchImpl,
    });
    expect(await source.viewerLogin("g1")).toBe("kari");
    expect(await source.viewerLogin("g1")).toBe("kari");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when the user lookup fails, and tries again next time", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const source = createRepoIssueSource({
      connections: { ...connections([ghe]), resolve: () => undefined },
      fetch: fetchImpl,
    });
    await expect(source.viewerLogin("g1")).rejects.toThrow();
    await expect(source.viewerLogin("g1")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GitHub delivery", () => {
  /** Records each write and answers like GitHub; the PR diff touches lines 1-2 of src/a.ts. */
  function recordingGitHub() {
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const path = new URL(String(input)).pathname;
      const accept = new Headers(init?.headers).get("accept") ?? "";
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (init?.method === "POST") {
        writes.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return Promise.resolve(
          json({ id: 1, number: 8, html_url: `https://acme.ghe.com/created${path}` }, 201),
        );
      }
      if (accept.includes("diff")) {
        return Promise.resolve(
          new Response(
            "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n",
            {
              headers: { "content-type": "text/plain" },
            },
          ),
        );
      }
      return Promise.resolve(
        json({
          number: 42,
          html_url: "",
          title: "",
          state: "open",
          head: { ref: "x", sha: "head-sha" },
          base: { ref: "main", sha: "b" },
        }),
      );
    });
    return { fetchImpl, writes };
  }

  const finding = (title: string, file: string | null, line: number | null) =>
    ({
      severity: "high",
      tags: ["correctness"],
      file,
      lineStart: line,
      lineEnd: line,
      title,
      explanation: "Why.",
      suggestedFix: null,
    }) as Finding;

  it("posts the selected findings as a COMMENT review anchored to the PR head", async () => {
    const { fetchImpl, writes } = recordingGitHub();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    const { url } = await github.reviewPullRequest(
      prTask("g1"),
      [finding("On the diff", "src/a.ts", 2), finding("Elsewhere", "src/b.ts", 9)],
      { approve: false },
    );
    expect(url).toBe("https://acme.ghe.com/created/repos/acme/shop/pulls/42/reviews");
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body;
    expect(body).toMatchObject({ event: "COMMENT", commit_id: "head-sha" });
    expect(body.comments).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT" }),
    ]);
    expect(body.body).toContain("Elsewhere");
    expect(body.body).toMatch(/_Posted from blackwall_$/);
    for (const comment of body.comments as { body: string }[]) {
      expect(comment.body).not.toContain("Posted from blackwall");
    }
  });

  it("approves the PR with no findings when asked", async () => {
    const { fetchImpl, writes } = recordingGitHub();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    await github.reviewPullRequest(prTask("g1"), [], { approve: true });
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body;
    expect(body).toMatchObject({ event: "APPROVE", commit_id: "head-sha", comments: [] });
    expect(body.body).toContain("No findings.");
    expect(body.body).toMatch(/_Posted from blackwall_$/);
  });

  it("approves the PR with the findings as inline comments", async () => {
    const { fetchImpl, writes } = recordingGitHub();
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fetchImpl });
    await github.reviewPullRequest(prTask("g1"), [finding("On the diff", "src/a.ts", 2)], {
      approve: true,
    });
    const body = writes[0]!.body;
    expect(body).toMatchObject({ event: "APPROVE", commit_id: "head-sha" });
    expect(body.comments).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT" }),
    ]);
  });

  it("comments on the PR and opens a PR on the remote's host", async () => {
    const { fetchImpl, writes } = recordingGitHub();
    const list = connections([ghe]);
    const github = createGitHubOrigin({ connections: list, fetch: fetchImpl });
    await github.commentOnPullRequest(prTask("g1"), "Summary");
    const { url } = await github.openPullRequest({
      kind: "open-pr",
      host: "acme.ghe.com",
      owner: "acme",
      repo: "shop",
      head: "feature/abc-1-x",
      base: "main",
      title: "ABC-1 X",
      body: "Summary",
    });
    expect(url).toBe("https://acme.ghe.com/created/repos/acme/shop/pulls");
    expect(list.requireCredential).toHaveBeenCalledWith({
      kind: "github",
      remote: "https://acme.ghe.com/acme/shop.git",
    });
    expect(writes).toEqual([
      {
        path: "/repos/acme/shop/issues/42/comments",
        body: { body: "Summary\n\n---\n_Posted from blackwall_" },
      },
      {
        path: "/repos/acme/shop/pulls",
        body: { head: "feature/abc-1-x", base: "main", title: "ABC-1 X", body: "Summary" },
      },
    ]);
  });

  it("refuses PR calls for tasks without a pull request", async () => {
    const github = createGitHubOrigin({ connections: connections([ghe]), fetch: fakeGitHub() });
    const freeText = { ...prTask(null), origin: { kind: "free-text" } } as Task;
    await expect(github.commentOnPullRequest(freeText, "x")).rejects.toThrow(/no pull request/);
  });
});

describe("ciChecks", () => {
  const githubCom: Connection = {
    id: "gh",
    name: "github.com",
    kind: "github",
    baseUrl: "https://github.com",
    authMeta: {},
    tokenSet: true,
  } as Connection;
  const target = { host: "github.com", owner: "acme", repo: "web", sha: "abc123" };
  const signal = () => new AbortController().signal;

  /**
   * Answers the commit's check runs and statuses; the check runs can be rate-limited.
   * Responses carry the request's URL, which Octokit's pagination reads.
   */
  function fakeCi({ rateLimited = false } = {}) {
    const answer: typeof fetch = (input) => {
      const path = new URL(String(input)).pathname;
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        });
      if (path === "/repos/acme/web/commits/abc123/check-runs") {
        if (rateLimited) {
          return Promise.resolve(
            json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }),
          );
        }
        return Promise.resolve(
          json({
            total_count: 1,
            check_runs: [
              {
                id: 7,
                name: "unit",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/acme/web/runs/7",
              },
            ],
          }),
        );
      }
      if (path === "/repos/acme/web/commits/abc123/status") {
        return Promise.resolve(
          json({
            state: "failure",
            sha: "abc123",
            statuses: [
              {
                id: 9,
                context: "deploy",
                state: "failure",
                description: "Deploy failed",
                target_url: "https://ci.example/9",
              },
            ],
          }),
        );
      }
      return Promise.resolve(json({ message: "Not Found" }, 404));
    };
    return vi.fn<typeof fetch>(async (input) => {
      const res = await answer(input);
      return Object.defineProperty(res, "url", { value: String(input) });
    });
  }

  it("reports a missing token instead of failing the watch", async () => {
    const list = connections([githubCom]);
    list.requireCredential.mockRejectedValueOnce(
      new MissingCredentialError("github", "github.com", null),
    );
    const fetchImpl = fakeCi();
    const origin = createGitHubOrigin({ connections: list, fetch: fetchImpl });
    expect(await origin.ciChecks(target, signal())).toEqual({
      checks: [],
      unreadable: [],
      missingToken: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects with CiRateLimitedError when GitHub rate-limits the check runs", async () => {
    const origin = createGitHubOrigin({
      connections: connections([githubCom]),
      fetch: fakeCi({ rateLimited: true }),
    });
    await expect(origin.ciChecks(target, signal())).rejects.toThrow(CiRateLimitedError);
  });

  it("reads the check runs and statuses of the commit", async () => {
    const fetchImpl = fakeCi();
    const origin = createGitHubOrigin({ connections: connections([githubCom]), fetch: fetchImpl });
    const result = await origin.ciChecks(target, signal());
    expect(result).toEqual({
      checks: [
        {
          name: "unit",
          kind: "check-run",
          id: 7,
          state: "passed",
          conclusion: "success",
          url: "https://github.com/acme/web/runs/7",
        },
        {
          name: "deploy",
          kind: "status",
          id: 9,
          state: "failed",
          conclusion: "failure",
          url: "https://ci.example/9",
        },
      ],
      unreadable: [],
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(
      "https://api.github.com/repos/acme/web/commits/abc123/check-runs?",
    );
  });
});
