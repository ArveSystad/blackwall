import type {
  Connection,
  ConnectionView,
  Finding,
  PullRequestLookup,
  Task,
} from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubOrigin,
  firstBranchFor,
  firstOriginContext,
  pullRequestRoutes,
} from "./github.js";

const TOKEN = "ghp_secret_token";

const ghe: Connection = {
  id: "g1",
  name: "jbf",
  kind: "github",
  baseUrl: "https://jbf.ghe.com",
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
      url: "https://jbf.ghe.com/acme/shop/pull/42",
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
    if (path === "/api/v3/repos/acme/shop/pulls/42") {
      if (accept.includes("diff")) {
        return Promise.resolve(
          new Response("diff --git a/x b/x\n", { headers: { "content-type": "text/plain" } }),
        );
      }
      return Promise.resolve(
        json({
          number: 42,
          html_url: "https://jbf.ghe.com/acme/shop/pull/42",
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
      remote: "https://jbf.ghe.com/acme/shop/pull/42",
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://jbf.ghe.com/api/v3/repos/acme/shop/pulls/42");
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

describe("pullRequestRoutes", () => {
  const routes = pullRequestRoutes({
    connections: {
      resolve: ({ kind, ...target }) =>
        kind === "github" && "remote" in target && target.remote.includes("jbf.ghe.com")
          ? ghe
          : undefined,
    },
    repos: {
      list: () =>
        [
          { id: "r1", remoteUrl: "git@jbf.ghe.com:acme/shop.git" },
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
    const res = await lookup("https://jbf.ghe.com/acme/shop/pull/42/files");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual<PullRequestLookup>({
      origin: {
        kind: "github-pr",
        url: "https://jbf.ghe.com/acme/shop/pull/42",
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
          json({ id: 1, number: 8, html_url: `https://jbf.ghe.com/created${path}` }, 201),
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
    expect(url).toBe("https://jbf.ghe.com/created/api/v3/repos/acme/shop/pulls/42/reviews");
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body;
    expect(body).toMatchObject({ event: "COMMENT", commit_id: "head-sha" });
    expect(body.comments).toEqual([
      expect.objectContaining({ path: "src/a.ts", line: 2, side: "RIGHT" }),
    ]);
    expect(body.body).toContain("Elsewhere");
  });

  it("comments on the PR and opens a PR on the remote's host", async () => {
    const { fetchImpl, writes } = recordingGitHub();
    const list = connections([ghe]);
    const github = createGitHubOrigin({ connections: list, fetch: fetchImpl });
    await github.commentOnPullRequest(prTask("g1"), "Summary");
    const { url } = await github.openPullRequest({
      kind: "open-pr",
      host: "jbf.ghe.com",
      owner: "acme",
      repo: "shop",
      head: "feature/abc-1-x",
      base: "main",
      title: "ABC-1 X",
      body: "Summary",
    });
    expect(url).toBe("https://jbf.ghe.com/created/api/v3/repos/acme/shop/pulls");
    expect(list.requireCredential).toHaveBeenCalledWith({
      kind: "github",
      remote: "https://jbf.ghe.com/acme/shop.git",
    });
    expect(writes).toEqual([
      { path: "/api/v3/repos/acme/shop/issues/42/comments", body: { body: "Summary" } },
      {
        path: "/api/v3/repos/acme/shop/pulls",
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
