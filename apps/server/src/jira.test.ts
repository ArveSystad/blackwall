import { MissingCredentialError } from "@blackwall/core";
import type { Connection, ConnectionView, RepoJiraIssues, Task } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import { createJiraOrigin, jiraIssueRoutes } from "./jira.js";

const TOKEN = "jira-secret-token";

const jiraConnection: Connection = {
  id: "c1",
  name: "acme",
  kind: "jira",
  baseUrl: "https://acme.atlassian.net",
  authMeta: { email: "ada@acme.test" },
  tokenSet: true,
} as Connection;

function connections(list: Connection[]) {
  return {
    list: () => list.map((c) => ({ ...c, hasToken: true }) as unknown as ConnectionView),
    credentialById: vi.fn(async (id: string) => ({
      connection: list.find((c) => c.id === id)!,
      token: TOKEN,
    })),
  };
}

const jiraTask = (connectionId: string | null) =>
  ({
    id: "t1",
    title: "Export invoices",
    origin: { kind: "jira-issue", key: "ABC-123", connectionId },
    baseBranch: null,
    worktreePath: null,
  }) as Task;

function fakeJira() {
  return vi.fn<typeof fetch>((input) => {
    const path = new URL(String(input)).pathname;
    const body =
      path === "/rest/api/3/issue/ABC-123"
        ? {
            id: "1",
            key: "ABC-123",
            fields: { summary: "Invoice totals are rounded twice", issuetype: { name: "Bug" } },
          }
        : {};
    return Promise.resolve(new Response(JSON.stringify(body)));
  });
}

describe("createJiraOrigin", () => {
  it("derives a fix/ branch for a Bug through the only Jira connection", async () => {
    const fetchImpl = fakeJira();
    const jira = createJiraOrigin({ connections: connections([jiraConnection]), fetch: fetchImpl });
    expect(await jira.branchFor(jiraTask(null))).toBe(
      "fix/abc-123-invoice-totals-are-rounded-twice",
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/ABC-123/);
    const basic = Buffer.from(`ada@acme.test:${TOKEN}`).toString("base64");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${basic}`);
  });

  it("renders the issue as Inform context", async () => {
    const jira = createJiraOrigin({
      connections: connections([jiraConnection]),
      fetch: fakeJira(),
    });
    const context = await jira.originContext(jiraTask("c1"), new AbortController().signal);
    expect(context).toContain("## Jira issue ABC-123: Invoice totals are rounded twice");
  });

  it("ignores other origins and asks for a connection when none exists", async () => {
    const jira = createJiraOrigin({ connections: connections([]), fetch: fakeJira() });
    const freeText = { ...jiraTask(null), origin: { kind: "free-text" } } as Task;
    expect(await jira.branchFor(freeText)).toBeUndefined();
    expect(await jira.originContext(freeText, new AbortController().signal)).toBeUndefined();
    await expect(jira.branchFor(jiraTask(null))).rejects.toBeInstanceOf(MissingCredentialError);
  });
});

describe("Jira delivery", () => {
  it("comments on the issue in ADF and links the comment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "10001" }), { status: 201 })),
    );
    const jira = createJiraOrigin({ connections: connections([jiraConnection]), fetch: fetchImpl });
    const { url } = await jira.commentOnIssue(jiraTask(null), "**Done**");
    expect(url).toBe("https://acme.atlassian.net/browse/ABC-123?focusedCommentId=10001");
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toBe("https://acme.atlassian.net/rest/api/3/issue/ABC-123/comment");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body)) as { body: { type: string } };
    expect(body.body.type).toBe("doc");
    // Only the comment: no transition or other write.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("links the issue when its site is known", () => {
    const jira = createJiraOrigin({
      connections: connections([jiraConnection]),
      fetch: fakeJira(),
    });
    expect(jira.issueUrl(jiraTask(null))).toBe("https://acme.atlassian.net/browse/ABC-123");
    expect(jira.issueUrl(jiraTask("other"))).toBeUndefined();
    const none = createJiraOrigin({ connections: connections([]), fetch: fakeJira() });
    expect(none.issueUrl(jiraTask(null))).toBeUndefined();
  });
});

describe("jiraIssueRoutes", () => {
  const site = (id: string, host: string, hasToken = true) =>
    ({
      id,
      name: host,
      kind: "jira",
      baseUrl: `https://${host}`,
      authMeta: { email: "ada@acme.test" },
      hasToken,
    }) as unknown as ConnectionView & Connection;
  const github = {
    ...site("g1", "github.com"),
    kind: "github",
  } as unknown as ConnectionView & Connection;

  const repos = [
    { id: "r1", jiraProject: "ABC" },
    { id: "r2", jiraProject: null },
  ];

  /** Answers the search with three issues out of order; other paths 404. */
  function searchJira(status = 200) {
    return vi.fn<typeof fetch>((input) => {
      const path = new URL(String(input)).pathname;
      if (path !== "/rest/api/3/search/jql" || status !== 200) {
        return Promise.resolve(new Response("{}", { status: status === 200 ? 404 : status }));
      }
      const issue = (key: string, updated: string, fields: Record<string, unknown> = {}) => ({
        id: key,
        key,
        fields: { summary: `Issue ${key}`, updated, ...fields },
      });
      const issues = [
        issue("ABC-1", "2026-10-01T10:00:00.000+0000"),
        issue("ABC-2", "2026-10-03T10:00:00.000+0000", {
          issuetype: { name: "Bug" },
          status: { name: "In Progress" },
          reporter: { displayName: "Kari" },
          assignee: { displayName: "Ada" },
        }),
        issue("ABC-3", "2026-10-02T10:00:00.000+0000"),
      ];
      return Promise.resolve(new Response(JSON.stringify({ issues })));
    });
  }

  function setup(list: (ConnectionView & Connection)[], fetchImpl = searchJira()) {
    const credentialById = vi.fn(async (id: string) => ({
      connection: list.find((c) => c.id === id)! as Connection,
      token: TOKEN,
    }));
    const routes = jiraIssueRoutes({
      connections: { list: () => list, credentialById },
      repos: { list: () => repos as never },
      fetch: fetchImpl,
    });
    return { routes, fetchImpl, credentialById };
  }

  const list = async (routes: ReturnType<typeof setup>["routes"], repoId = "r1") =>
    (await (await routes.request(`/${repoId}`)).json()) as RepoJiraIssues;

  it("answers 404 for an unknown repo", async () => {
    const { routes } = setup([site("c1", "acme.atlassian.net")]);
    expect((await routes.request("/nope")).status).toBe(404);
  });

  it("lists nothing, without reading a token, for a repo without a project or a site", async () => {
    const withSite = setup([site("c1", "acme.atlassian.net")]);
    expect(await list(withSite.routes, "r2")).toEqual({ issues: [], errors: [] });
    expect(withSite.credentialById).not.toHaveBeenCalled();

    const noSite = setup([github]);
    expect(await list(noSite.routes)).toEqual({ issues: [], errors: [] });
    expect(noSite.credentialById).not.toHaveBeenCalled();

    const noToken = setup([site("c1", "acme.atlassian.net", false)]);
    expect(await list(noToken.routes)).toEqual({ issues: [], errors: [] });
    expect(noToken.credentialById).not.toHaveBeenCalled();
  });

  it("lists the project's issues, newest first, through the only site with a token", async () => {
    const { routes, fetchImpl } = setup([
      site("c1", "old.atlassian.net", false),
      site("c2", "acme.atlassian.net"),
    ]);
    const body = await list(routes);
    expect(body.errors).toEqual([]);
    expect(body.issues.map((issue) => issue.key)).toEqual(["ABC-2", "ABC-3", "ABC-1"]);
    expect(body.issues[0]).toEqual({
      host: "acme.atlassian.net",
      key: "ABC-2",
      title: "Issue ABC-2",
      url: "https://acme.atlassian.net/browse/ABC-2",
      issueType: "Bug",
      status: "In Progress",
      author: "Kari",
      assignee: "Ada",
      updatedAt: "2026-10-03T10:00:00.000Z",
      repoId: "r1",
      connectionId: "c2",
    });
    expect(body.issues[2]).toMatchObject({
      issueType: null,
      status: null,
      author: null,
      assignee: null,
    });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.host).toBe("acme.atlassian.net");
    expect(url.searchParams.get("jql")).toBe(
      'project = "ABC" AND statusCategory != Done ' +
        "AND (assignee is EMPTY OR assignee = currentUser()) ORDER BY updated DESC",
    );
  });

  it("reports several sites with a token instead of picking one", async () => {
    const { routes, credentialById } = setup([
      site("c1", "acme.atlassian.net"),
      site("c2", "other.atlassian.net"),
    ]);
    const body = await list(routes);
    expect(body.issues).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.message).toMatch(/Several Jira sites/);
    expect(credentialById).not.toHaveBeenCalled();
  });

  it("reports a connection without an account email", async () => {
    const noEmail = { ...site("c1", "acme.atlassian.net"), authMeta: {} } as typeof github;
    const body = await list(setup([noEmail]).routes);
    expect(body.issues).toEqual([]);
    expect(body.errors).toEqual([
      { host: "acme.atlassian.net", message: expect.stringMatching(/no account email/) },
    ]);
  });

  it("reports a Jira failure instead of throwing", async () => {
    const body = await list(setup([site("c1", "acme.atlassian.net")], searchJira(403)).routes);
    expect(body).toEqual({
      issues: [],
      errors: [{ host: "acme.atlassian.net", message: "acme.atlassian.net: access denied" }],
    });
  });
});
