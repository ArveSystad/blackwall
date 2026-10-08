import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adfToMarkdown, type AdfNode } from "./adf.js";
import type { JiraCommentJson, JiraIssueJson } from "./client.js";
import { markdownToAdf } from "./markdown-to-adf.js";

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

const issue = fixture<JiraIssueJson>("issue-abc-123.json");
const comments = fixture<{ comments: JiraCommentJson[] }>("comments-abc-123.json").comments;

describe("adfToMarkdown", () => {
  it("converts a recorded issue description", () => {
    expect(adfToMarkdown(issue.fields.description)).toBe(
      [
        "As an **accountant** I want to export invoices as CSV, see [the spec](https://wiki.acme.test/csv).",
        "Use `InvoiceExporter`.",
        "",
        "## Acceptance criteria",
        "",
        "1. Columns match the sample",
        "2. Dates are ISO 8601",
        "",
        "   - ~~in UTC~~",
        "",
        "> **Warning:** Large exports must stream.",
        "",
        "```ts",
        'exportInvoices({ format: "csv" });',
        "```",
        "",
        "| Column | Format |",
        "| --- | --- |",
        "| amount | 0.00 \\| NOK |",
        "",
        "[attachment: mockup.png]",
        "",
        "<https://acme.atlassian.net/browse/OPS-7> [BLOCKED] !",
        "",
        "---",
      ].join("\n"),
    );
  });

  it("converts recorded comments with mentions, quotes and task lists", () => {
    expect(comments.map((c) => adfToMarkdown(c.body))).toEqual([
      "@Ada Lovelace should the export include *voided* invoices?",
      [
        "# Decision",
        "",
        "> No, skip voided invoices.",
        "",
        "- [x] Agreed with finance",
        "- [ ] Update the spec",
      ].join("\n"),
    ]);
  });

  it("handles empty, plain-string and unknown input", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown("  plain  ")).toBe("plain");
    const unknown: AdfNode = {
      type: "doc",
      content: [{ type: "fancyBlock", content: [{ type: "text", text: "kept" }] }],
    };
    expect(adfToMarkdown(unknown)).toBe("kept");
  });
});

describe("markdownToAdf", () => {
  it("converts blocks and inline marks", () => {
    const doc = markdownToAdf(
      [
        "## Summary",
        "",
        "Changed **two** files, see [PR](https://ghe.test/pr/1) and `src/a.ts`.",
        "Second line.",
        "",
        "- one",
        "  - nested *em*",
        "- two",
        "",
        "3. third",
        "",
        "> quoted",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | ~~2~~ |",
        "",
        "---",
      ].join("\n"),
    );
    expect(doc).toEqual({
      type: "doc",
      version: 1,
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Summary" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Changed " },
            { type: "text", text: "two", marks: [{ type: "strong" }] },
            { type: "text", text: " files, see " },
            {
              type: "text",
              text: "PR",
              marks: [{ type: "link", attrs: { href: "https://ghe.test/pr/1" } }],
            },
            { type: "text", text: " and " },
            { type: "text", text: "src/a.ts", marks: [{ type: "code" }] },
            { type: "text", text: "." },
            { type: "hardBreak" },
            { type: "text", text: "Second line." },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            { type: "text", text: "nested " },
                            { type: "text", text: "em", marks: [{ type: "em" }] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
            },
          ],
        },
        {
          type: "orderedList",
          attrs: { order: 3 },
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "third" }] }],
            },
          ],
        },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }],
        },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1;" }],
        },
        {
          type: "table",
          attrs: { isNumberColumnEnabled: false, layout: "default" },
          content: [
            {
              type: "tableRow",
              content: ["A", "B"].map((text) => ({
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              })),
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "2", marks: [{ type: "strike" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "rule" },
      ],
    });
  });

  it("links bare URLs and leaves snake_case alone", () => {
    const [paragraph] = markdownToAdf("See https://acme.test/x. Use my_var_name.").content;
    expect(paragraph?.content).toEqual([
      { type: "text", text: "See " },
      {
        type: "text",
        text: "https://acme.test/x",
        marks: [{ type: "link", attrs: { href: "https://acme.test/x" } }],
      },
      { type: "text", text: ". Use my_var_name." },
    ]);
  });

  it("round-trips agent-style markdown through ADF", () => {
    const markdown = [
      "## Result",
      "",
      "Implemented **CSV export** in `InvoiceExporter`.",
      "",
      "1. Added the serializer",
      "2. Streamed large exports",
      "",
      "- [link](https://acme.test)",
      "",
      "> Note",
      "",
      "```",
      "pnpm test",
      "```",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });
});
