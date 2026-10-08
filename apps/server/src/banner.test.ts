import { describe, expect, it } from "vitest";
import { banner } from "./banner.js";

describe("server", () => {
  it("wires core and integrations together", () => {
    expect(banner()).toBe("blackwall core + blackwall integrations");
  });
});
