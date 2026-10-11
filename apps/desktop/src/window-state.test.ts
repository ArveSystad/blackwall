import { describe, expect, it } from "vitest";
import { visibleBounds } from "./window-state.js";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const right = { x: 1920, y: 0, width: 2560, height: 1400 };

describe("visibleBounds", () => {
  it("keeps bounds that overlap a work area", () => {
    const saved = { x: 100, y: 100, width: 1200, height: 800 };
    expect(visibleBounds(saved, [primary])).toEqual(saved);
    const straddling = { x: 1800, y: 50, width: 800, height: 600 };
    expect(visibleBounds(straddling, [primary, right])).toEqual(straddling);
  });

  it("drops bounds on a display that is gone", () => {
    expect(visibleBounds({ x: 2200, y: 100, width: 800, height: 600 }, [primary])).toBeUndefined();
  });

  it("is undefined without saved bounds", () => {
    expect(visibleBounds(undefined, [primary])).toBeUndefined();
  });
});
