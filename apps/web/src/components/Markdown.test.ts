import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("shows the source as plain text until the renderer chunk loads", () => {
    const html = renderToStaticMarkup(createElement(Markdown, null, "## Goal"));
    expect(html).toContain("## Goal");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).not.toContain("<h2");
  });
});
