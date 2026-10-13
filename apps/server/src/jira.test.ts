import { MissingCredentialError } from "@blackwall/core";
import type { Connection, ConnectionView, Task } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import { createJiraOrigin } from "./jira.js";

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
