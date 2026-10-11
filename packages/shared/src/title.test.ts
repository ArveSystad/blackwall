import { describe, expect, it } from "vitest";
import { documentTitle, needsYouCountFromTitle } from "./index.js";

describe("documentTitle", () => {
  it("shows the needs-you count when there is one", () => {
    expect(documentTitle(2)).toBe("(2) blackwall");
  });

  it("shows just the name when nothing needs attention", () => {
    expect(documentTitle(0)).toBe("blackwall");
  });
});

describe("needsYouCountFromTitle", () => {
  it("reads back the count documentTitle wrote", () => {
    for (const n of [0, 1, 2, 42]) expect(needsYouCountFromTitle(documentTitle(n))).toBe(n);
  });

  it("is 0 for unrelated titles", () => {
    expect(needsYouCountFromTitle("foo")).toBe(0);
    expect(needsYouCountFromTitle("(x) blackwall")).toBe(0);
    expect(needsYouCountFromTitle("(3) blackwall extra")).toBe(0);
  });
});
