import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlightLines } from "../syntax";
import type { DiffLine } from "../task-view";
import { DiffView } from "./DiffView";

const lines: DiffLine[] = [
  { kind: "ctx", text: "const a = 1;", line: 1 },
  { kind: "add", text: "let b = 2;", line: 2 },
];

describe("DiffView", () => {
  it("renders syntax tokens as spans when given tokens", () => {
    const tokens = highlightLines(lines, "a.ts")!;
    const html = renderToStaticMarkup(createElement(DiffView, { lines, tokens }));
    expect(html).toContain("bw-syntax");
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain("bg-diff-add");
  });

  it("renders plain text without tokens", () => {
    const html = renderToStaticMarkup(createElement(DiffView, { lines }));
    expect(html).not.toContain("hljs");
    expect(html).not.toContain("bw-syntax");
    expect(html).toContain("const a = 1;");
  });
});
