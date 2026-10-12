import { describe, expect, it } from "vitest";
import { issuePillLabel } from "./assigned-issues";

describe("issuePillLabel", () => {
  it("counts in words", () => {
    expect(issuePillLabel(0)).toBe("No issues assigned to you");
    expect(issuePillLabel(1)).toBe("1 issue assigned to you");
    expect(issuePillLabel(3)).toBe("3 issues assigned to you");
  });
});
