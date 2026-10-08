import { describe, expect, it } from "vitest";
import { describeCore } from "./index.js";

describe("core", () => {
  it("consumes @blackwall/shared", () => {
    expect(describeCore()).toBe("blackwall core");
  });
});
