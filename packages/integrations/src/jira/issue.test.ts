import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupportedAttachment, safeFileName } from "./attachments.js";
import { createJiraClient, JiraError, type JiraIssueJson } from "./client.js";
import { informFromJira } from "./inform.js";
import { assembleJiraIssue } from "./issue.js";
import { parseJiraIssueRef } from "./issue-ref.js";

const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const fixtureText = (name: string) => readFileSync(fixturePath(name), "utf8");
const issueJson = JSON.parse(fixtureText("issue-abc-123.json")) as JiraIssueJson;

const CREDENTIALS = {
  baseUrl: "https://acme.atlassian.net/jira/software",
  email: "ada@acme.test",
  token: "jira-secret-token",
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const CSV = "id,amount\n1,10.00\n";

/** Serves the recorded fixtures by path, like Jira Cloud would. */
function recordedJira() {
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const json = (name: string) =>
      new Response(fixtureText(name), { headers: { "content-type": "application/json" } });
    if (path === "/rest/api/3/issue/ABC-123") return Promise.resolve(json("issue-abc-123.json"));
    if (path === "/rest/api/3/issue/ABC-123/comment")
      return Promise.resolve(json("comments-abc-123.json"));
    if (path === "/rest/api/3/issue/ABC-100") return Promise.resolve(json("parent-abc-100.json"));
    if (path === "/rest/api/3/attachment/content/10010") return Promise.resolve(new Response(PNG));
    if (path === "/rest/api/3/attachment/content/10011") return Promise.resolve(new Response(CSV));
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "blackwall-jira-"));
  dirs.push(dir);
  return dir;
}

describe("parseJiraIssueRef", () => {
  it("accepts keys and issue URLs", () => {
    expect(parseJiraIssueRef(" abc-123 ")).toEqual({ key: "ABC-123" });
    expect(parseJiraIssueRef("https://acme.atlassian.net/browse/ABC-123")).toEqual({
      key: "ABC-123",
      baseUrl: "https://acme.atlassian.net",
    });
    expect(
      parseJiraIssueRef(
        "https://acme.atlassian.net/jira/software/projects/ABC/boards/1?selectedIssue=ABC-7",
      ),
    ).toEqual({ key: "ABC-7", baseUrl: "https://acme.atlassian.net" });
    expect(parseJiraIssueRef("https://acme.atlassian.net/rest/api/3/issue/ABC-9")?.key).toBe(
      "ABC-9",
    );
  });

  it("rejects anything else", () => {
    expect(parseJiraIssueRef("ABC")).toBeUndefined();
    expect(parseJiraIssueRef("https://acme.atlassian.net/jira/your-work")).toBeUndefined();
    expect(parseJiraIssueRef("ftp://acme.test/browse/ABC-1")).toBeUndefined();
  });
});

describe("assembleJiraIssue", () => {
  it("assembles the recorded issue", () => {
    const issue = assembleJiraIssue(issueJson, {
      url: "https://acme.atlassian.net/browse/ABC-123",
    });
    expect(issue).toMatchObject({
      key: "ABC-123",
      summary: "Export invoices as CSV",
      type: "Story",
      status: "In Progress",
      priority: "High",
      labels: ["billing", "export"],
      reporter: "Ada Lovelace",
      assignee: null,
      parent: {
        key: "ABC-100",
        type: "Epic",
        status: "In Progress",
        summary: "Billing self-service",
        description: "",
      },
      subtasks: [
        { key: "ABC-124", type: "Subtask", status: "Done", summary: "Add CSV serializer" },
      ],
      links: [
        { relation: "is blocked by", key: "ABC-90", type: "Bug" },
        { relation: "relates to", key: "OPS-7", type: "Task" },
      ],
    });
    expect(issue.comments).toHaveLength(1);
    expect(issue.attachments.map((a) => a.filename)).toEqual([
      "mockup.png",
      "sample-export.csv",
      "screen-recording.mov",
      "spec.pdf",
    ]);
  });
});

describe("informFromJira", () => {
  it("fetches the issue, every comment and the parent, and downloads attachments", async () => {
    const fetchImpl = recordedJira();
    const worktreePath = tempDir();
    const result = await informFromJira(CREDENTIALS, "ABC-123", {
      worktreePath,
      fetch: fetchImpl,
      limits: { maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 50 * 1024 * 1024 },
    });

    // Every request stays on the site's origin with Basic auth.
    const basic = `Basic ${Buffer.from("ada@acme.test:jira-secret-token").toString("base64")}`;
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(new URL(String(input)).origin).toBe("https://acme.atlassian.net");
      expect((init?.headers as Record<string, string>).authorization).toBe(basic);
    }

    expect(result.issue.comments.map((c) => c.author)).toEqual(["Grace Hopper", "Ada Lovelace"]);
    expect(result.issue.parent?.description).toBe(
      "# Goal\n\nCustomers manage invoices without support.",
    );

    expect(result.attachments).toEqual([
      expect.objectContaining({ saved: true, path: ".blackwall/jira/ABC-123/mockup.png" }),
      expect.objectContaining({ saved: true, path: ".blackwall/jira/ABC-123/sample-export.csv" }),
      expect.objectContaining({ saved: false, reason: "not an image, PDF or text file" }),
      expect.objectContaining({ saved: false, reason: "larger than the 10 MB limit" }),
    ]);
    const scratch = join(worktreePath, ".blackwall");
    expect(readFileSync(join(scratch, ".gitignore"), "utf8")).toBe("*\n");
    expect(readFileSync(join(scratch, "jira", "ABC-123", "sample-export.csv"), "utf8")).toBe(CSV);
    expect(new Uint8Array(readFileSync(join(scratch, "jira", "ABC-123", "mockup.png")))).toEqual(
      PNG,
    );

    await expect(result.markdown).toMatchFileSnapshot("./fixtures/abc-123.context.md");
  });

  it("only lists attachments without a worktree", async () => {
    const fetchImpl = recordedJira();
    const result = await informFromJira(CREDENTIALS, "ABC-123", { fetch: fetchImpl });
    expect(result.attachments).toEqual([]);
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("/attachment/"))).toBe(false);
  });

  it("enforces the total download cap", async () => {
    const result = await informFromJira(CREDENTIALS, "ABC-123", {
      worktreePath: tempDir(),
      fetch: recordedJira(),
      limits: { maxFileBytes: 4096, maxTotalBytes: 2100 },
    });
    expect(result.attachments.map((a) => (a.saved ? "saved" : a.reason))).toEqual([
      "saved",
      "the 2 KB total download limit is reached",
      "not an image, PDF or text file",
      "larger than the 4 KB limit",
    ]);
  });
});

describe("createJiraClient", () => {
  it("reports failures without the token", async () => {
    const client = createJiraClient(CREDENTIALS, () =>
      Promise.resolve(new Response("{}", { status: 404 })),
    );
    const error = await client.getIssue("ABC-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraError);
    expect((error as JiraError).message).toBe(
      "acme.atlassian.net: Issue ABC-1 not found (or not visible to this account)",
    );

    const offline = createJiraClient(CREDENTIALS, () =>
      Promise.reject(new Error(CREDENTIALS.token)),
    );
    await expect(offline.getIssue("ABC-1")).rejects.toThrow(
      "acme.atlassian.net: could not connect",
    );
  });

  it("posts markdown comments as ADF", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ id: "30001" }), { status: 201 })),
    );
    const client = createJiraClient(CREDENTIALS, fetchImpl);
    expect(await client.addComment("ABC-123", "Done: **merged**")).toEqual({ id: "30001" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/issue/ABC-123/comment");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Done: " },
              { type: "text", text: "merged", marks: [{ type: "strong" }] },
            ],
          },
        ],
      },
    });
  });

  it("stops reading an attachment past the cap", async () => {
    const client = createJiraClient(CREDENTIALS, () =>
      Promise.resolve(new Response(new Uint8Array(100))),
    );
    expect(await client.downloadAttachment("1", 50)).toBeUndefined();
    expect(await client.downloadAttachment("1", 100)).toHaveLength(100);
  });
});

describe("attachment helpers", () => {
  it("accepts images, PDFs and text files", () => {
    const a = (mimeType: string, filename = "f") => ({ id: "1", filename, mimeType, size: 1 });
    expect(isSupportedAttachment(a("image/jpeg"))).toBe(true);
    expect(isSupportedAttachment(a("application/pdf"))).toBe(true);
    expect(isSupportedAttachment(a("text/plain; charset=utf-8"))).toBe(true);
    expect(isSupportedAttachment(a("application/octet-stream", "server.log"))).toBe(true);
    expect(isSupportedAttachment(a("application/zip", "logs.zip"))).toBe(false);
  });

  it("makes file names safe", () => {
    expect(safeFileName("../../etc/passwd", "x")).toBe("passwd");
    expect(safeFileName("a:b*c?.txt", "x")).toBe("a_b_c_.txt");
    expect(safeFileName("..", "fallback")).toBe("fallback");
  });
});
