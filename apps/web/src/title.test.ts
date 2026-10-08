import { describe, expect, it } from "vitest";
import { documentTitle } from "./title";

describe("documentTitle", () => {
  it("shows the needs-you count when there is one", () => {
    expect(documentTitle(2)).toBe("(2) blackwall");
  });

  it("shows just the name when nothing needs attention", () => {
    expect(documentTitle(0)).toBe("blackwall");
  });
});
