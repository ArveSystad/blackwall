import { describe, expect, it } from "vitest";
import { ORIGINS, ORIGIN_ICONS } from "./origins";

describe("origins", () => {
  it("has an icon for every origin", () => {
    for (const { value, icon } of ORIGINS) expect(ORIGIN_ICONS[value]).toBe(icon);
  });
});
