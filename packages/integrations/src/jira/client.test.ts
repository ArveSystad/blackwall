import { describe, expect, it, vi } from "vitest";
import { createJiraClient } from "./client.js";

const CREDENTIALS = {
  baseUrl: "https://acme.atlassian.net",
  email: "ada@acme.test",
  token: "jira-secret-token",
};

describe("searchIssues", () => {
  it("sends the JQL, fields and page size to the search endpoint with Basic auth", async () => {
    const issue = { id: "1", key: "ABC-1", fields: { summary: "Totals drift" } };
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ issues: [issue] }))),
    );
    const client = createJiraClient(CREDENTIALS, fetchImpl);
    expect(await client.searchIssues('project = "ABC"', { maxResults: 50 })).toEqual([issue]);
    const [input, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://acme.atlassian.net/rest/api/3/search/jql");
    expect(url.searchParams.get("jql")).toBe('project = "ABC"');
    expect(url.searchParams.get("fields")).toBe(
      "summary,issuetype,status,assignee,reporter,updated",
    );
    expect(url.searchParams.get("maxResults")).toBe("50");
    const basic = Buffer.from(`ada@acme.test:jira-secret-token`).toString("base64");
    expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${basic}`);
  });

  it("reads up to 100 issues by default and returns none when Jira sends no list", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}")));
    const client = createJiraClient(CREDENTIALS, fetchImpl);
    expect(await client.searchIssues("project = ABC")).toEqual([]);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get("maxResults")).toBe("100");
  });
});
