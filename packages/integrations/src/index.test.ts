import { describe, expect, it } from "vitest";
import { describeIntegrations } from "./index.js";

describe("integrations", () => {
  it("consumes @blackwall/shared", () => {
    expect(describeIntegrations()).toBe("blackwall integrations");
  });
});
