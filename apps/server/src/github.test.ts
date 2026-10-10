import { MissingCredentialError } from "@blackwall/core";
import type {
  Connection,
  ConnectionView,
  Finding,
  IssueLookup,
  PullRequestLookup,
  Task,
} from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubOrigin,
  firstBranchFor,
  firstOriginContext,
  issueRoutes,
  pullRequestRoutes,
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
    expect(await github.originContext(freeText, signal)).toBeUndefined();
    const other = async () => "agent/t1";
    expect(await firstBranchFor(github.branchFor, other)(freeText)).toBe("agent/t1");
    expect(await firstOriginContext(github.originContext)(freeText, signal)).toBeUndefined();
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
  ({ id: "t2", title: "Export", origin: issueOrigin, worktreePath: null }) as Task;

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
  });
});

describe("issueRoutes", () => {
  const routes = issueRoutes({
    connections: {
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("acme.ghe.com")
          ? ghe
          : undefined,
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
    const { url } = await github.reviewPullRequest(prTask("g1"), [
      finding("On the diff", "src/a.ts", 2),
      finding("Elsewhere", "src/b.ts", 9),
    ]);
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
