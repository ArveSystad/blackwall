import { describe, expect, it } from "vitest";
import { boomsOnRise } from "./count-boom";

describe("boomsOnRise", () => {
  it("booms when the count rises from zero", () => {
    expect(boomsOnRise(0, 1)).toBe(true);
    expect(boomsOnRise(0, 5)).toBe(true);
  });

  it("does not boom on the first known count", () => {
    expect(boomsOnRise(null, 3)).toBe(false);
  });

  it("does not boom on growth from above zero", () => {
    expect(boomsOnRise(2, 3)).toBe(false);
  });

  it("does not boom when the count falls or stays at zero", () => {
    expect(boomsOnRise(3, 0)).toBe(false);
    expect(boomsOnRise(0, 0)).toBe(false);
  });

  it("does not boom on an unknown count", () => {
    expect(boomsOnRise(0, null)).toBe(false);
  });
});
