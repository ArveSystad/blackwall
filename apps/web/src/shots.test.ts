import { describe, expect, it } from "vitest";
import {
  AUTO_FIRE_MS,
  MAX_SHOTS,
  SPARKS_MAX,
  SPARKS_MIN,
  SPARK_DELAY_MAX,
  SPARK_LENGTH_MAX,
  SPARK_LENGTH_MIN,
  SPARK_REACH_MAX,
  SPARK_REACH_MIN,
  addShot,
  advanceTrigger,
  aimTrigger,
  makeShot,
  makeSparks,
  pullTrigger,
  type Shot,
  type Trigger,
} from "./shots";

const shot = (id: number): Shot => ({ id, x: id * 10, y: id * 20, angle: 0, sparks: [] });

/** A deterministic `random` cycling through `values`. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

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

describe("makeSparks", () => {
  it("makes SPARKS_MIN sparks at the low end and SPARKS_MAX at the high end", () => {
    expect(makeSparks(() => 0)).toHaveLength(SPARKS_MIN);
    expect(makeSparks(() => 0.999)).toHaveLength(SPARKS_MAX);
  });

  it("keeps every spark within its ranges", () => {
    for (const random of [() => 0, () => 0.999, sequence(0.1, 0.7, 0.35, 0.9, 0.05)]) {
      const sparks = makeSparks(random);
      expect(sparks.length).toBeGreaterThanOrEqual(SPARKS_MIN);
      expect(sparks.length).toBeLessThanOrEqual(SPARKS_MAX);
      for (const spark of sparks) {
        expect(spark.angle).toBeGreaterThanOrEqual(0);
        expect(spark.angle).toBeLessThan(360);
        expect(spark.reach).toBeGreaterThanOrEqual(SPARK_REACH_MIN);
        expect(spark.reach).toBeLessThanOrEqual(SPARK_REACH_MAX);
        expect(spark.length).toBeGreaterThanOrEqual(SPARK_LENGTH_MIN);
        expect(spark.length).toBeLessThanOrEqual(SPARK_LENGTH_MAX);
        expect(spark.delay).toBeGreaterThanOrEqual(0);
        expect(spark.delay).toBeLessThanOrEqual(SPARK_DELAY_MAX);
      }
    }
  });

  it("is deterministic for the same random sequence", () => {
    const values = [0.4, 0.2, 0.8, 0.6, 0.1, 0.3];
    expect(makeSparks(sequence(...values))).toEqual(makeSparks(sequence(...values)));
  });
});

describe("makeShot", () => {
  it("keeps the id and position, with a flash angle and sparks", () => {
    const made = makeShot(7, 12, 34, sequence(0.5, 0.25));
    expect(made).toMatchObject({ id: 7, x: 12, y: 34, angle: 180 });
    expect(made.sparks.length).toBeGreaterThanOrEqual(SPARKS_MIN);
  });

  it("keeps the angle within [0, 360)", () => {
    expect(makeShot(0, 0, 0, () => 0).angle).toBe(0);
    expect(makeShot(0, 0, 0, () => 0.999).angle).toBeLessThan(360);
  });
});

describe("trigger", () => {
  it("pullTrigger fires the first shot at once", () => {
    expect(pullTrigger(1, 2, 500)).toEqual({ x: 1, y: 2, lastShotAt: 500 });
  });

  it("aimTrigger moves the aim and keeps the cadence", () => {
    expect(aimTrigger(pullTrigger(1, 2, 500), 30, 40)).toEqual({ x: 30, y: 40, lastShotAt: 500 });
  });

  it("does not fire before AUTO_FIRE_MS", () => {
    const trigger = pullTrigger(0, 0, 0);
    const next = advanceTrigger(trigger, AUTO_FIRE_MS - 1);
    expect(next.fire).toBe(false);
    expect(next.trigger).toBe(trigger);
  });

  it("fires at AUTO_FIRE_MS", () => {
    expect(advanceTrigger(pullTrigger(0, 0, 0), AUTO_FIRE_MS).fire).toBe(true);
  });

  it("keeps a steady cadence at 16ms frames", () => {
    let trigger: Trigger = pullTrigger(0, 0, 0);
    let shots = 0;
    for (let now = 16; now <= 1000; now += 16) {
      const next = advanceTrigger(trigger, now);
      trigger = next.trigger;
      if (next.fire) shots++;
    }
    expect(shots).toBe(Math.floor(1000 / AUTO_FIRE_MS));
  });

  it("fires once after a stall, with no burst to catch up", () => {
    const stalled = advanceTrigger(pullTrigger(0, 0, 0), 2000);
    expect(stalled.fire).toBe(true);
    expect(advanceTrigger(stalled.trigger, 2000).fire).toBe(false);
    expect(advanceTrigger(stalled.trigger, 2000 + AUTO_FIRE_MS).fire).toBe(true);
  });
});
