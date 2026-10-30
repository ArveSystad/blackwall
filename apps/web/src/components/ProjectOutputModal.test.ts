import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutputText } from "./ProjectOutputModal";

const render = (text: string) => renderToStaticMarkup(createElement(OutputText, { text }));

describe("OutputText", () => {
  it("links URLs in a new tab", () => {
    const html = render("Local: http://localhost:5173/\n");
    expect(html).toContain('href="http://localhost:5173/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("http://localhost:5173/</a>");
  });

  it("renders text without URLs as plain text", () => {
    expect(render("compiled in 120 ms\n")).not.toContain("<a");
  });

  it("escapes markup in the output", () => {
    const html = render("<b>bold</b> http://x.test/");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });
});
