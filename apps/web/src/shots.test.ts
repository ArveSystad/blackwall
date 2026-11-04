import { describe, expect, it } from "vitest";
import { MAX_SHOTS, addShot, type Shot } from "./shots";

const shot = (id: number): Shot => ({ id, x: id * 10, y: id * 20 });

describe("addShot", () => {
  it("appends the shot", () => {
    expect(addShot([], shot(1))).toEqual([shot(1)]);
  });

  it("keeps the shots in firing order", () => {
    expect(addShot([shot(1), shot(2)], shot(3))).toEqual([shot(1), shot(2), shot(3)]);
  });

  it("drops the oldest at MAX_SHOTS and keeps the newest", () => {
    const full = Array.from({ length: MAX_SHOTS }, (_, i) => shot(i));
    const next = addShot(full, shot(MAX_SHOTS));
    expect(next).toHaveLength(MAX_SHOTS);
    expect(next.map((s) => s.id)).toEqual(Array.from({ length: MAX_SHOTS }, (_, i) => i + 1));
  });

  it("does not mutate its input", () => {
    const shots = [shot(1)];
    addShot(shots, shot(2));
    expect(shots).toEqual([shot(1)]);
  });
});
