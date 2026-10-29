import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./MarkdownRenderer";

const render = (src: string) => renderToStaticMarkup(createElement(MarkdownRenderer, null, src));

describe("MarkdownRenderer", () => {
  it("renders headings without the literal hashes", () => {
    const html = render("## Goal");
    expect(html).toContain("<h2");
    expect(html).toContain("Goal</h2>");
    expect(html).not.toContain("##");
  });

  it("renders bullet lists", () => {
    expect(render("- a")).toMatch(/<ul[^>]*>\s*<li>a<\/li>\s*<\/ul>/);
  });

  it("styles inline code as a chip", () => {
    const classes = /<code class="([^"]*)">x<\/code>/.exec(render("use `x` here"))?.[1]?.split(" ");
    expect(classes).toEqual(
      expect.arrayContaining(["bg-code-inline", "px-1", "text-code", "text-foreground-strong"]),
    );
  });

  it("renders fenced code as a block without the inline chip", () => {
    for (const src of ["```ts\nconst a = 1;\n```", "```\nplain\n```"]) {
      const html = render(src);
      expect(html).toMatch(/<pre[^>]*><code/);
      const code = /<code[^>]*>/.exec(html)?.[0] ?? "";
      expect(code).not.toContain("bg-code");
      expect(code).not.toContain("px-1");
      expect(code).not.toContain("text-foreground-strong");
    }
  });

  it("renders GFM tables", () => {
    expect(render("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<table");
  });

  it("does not render raw HTML", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
  });

  it("opens links in a new tab", () => {
    const html = render("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
