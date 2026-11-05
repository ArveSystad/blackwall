import { describe, expect, it } from "vitest";
import {
  SHIP_DEBRIS,
  SHIP_FLIGHT_MAX_MS,
  SHIP_FLIGHT_MIN_MS,
  SHIP_GAP_MAX_MS,
  SHIP_GAP_MIN_MS,
  SHIP_HIT_PAD,
  SHIP_HUES,
  SHIP_LIGHT_COMBOS,
  SHIP_SCALE_MAX,
  SHIP_SCALE_MIN,
  SHIP_Y_FAR,
  SHIP_Y_NEAR,
  hitShip,
  makeShip,
  makeShipBoom,
  shipGapMs,
  type ShipTarget,
} from "./ships";

/** A deterministic `random` cycling through `values`. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

const target = (
  id: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): ShipTarget => ({
  id,
  left,
  top,
  right,
  bottom,
});

describe("shipGapMs", () => {
  it("stays within its min and max", () => {
    expect(shipGapMs(() => 0)).toBe(SHIP_GAP_MIN_MS);
    expect(shipGapMs(() => 0.999)).toBeLessThanOrEqual(SHIP_GAP_MAX_MS);
    expect(shipGapMs(() => 0.5)).toBeGreaterThan(SHIP_GAP_MIN_MS);
  });
});

describe("makeShip", () => {
  it("is far at depth 0: smallest, slowest and lowest", () => {
    const ship = makeShip(3, () => 0);
    expect(ship).toMatchObject({
      id: 3,
      depth: 0,
      scale: SHIP_SCALE_MIN,
      durationMs: SHIP_FLIGHT_MAX_MS,
      y: SHIP_Y_FAR,
      direction: "ltr",
      hue: SHIP_HUES[0],
      lights: SHIP_LIGHT_COMBOS[0],
    });
  });

  it("is near at the high end: biggest, fastest and highest", () => {
    const ship = makeShip(4, () => 0.999);
    expect(ship.scale).toBeCloseTo(SHIP_SCALE_MAX, 2);
    expect(ship.durationMs).toBeCloseTo(SHIP_FLIGHT_MIN_MS, -2);
    expect(ship.y).toBeCloseTo(SHIP_Y_NEAR, 1);
    expect(ship.direction).toBe("rtl");
    expect(ship.hue).toBe(SHIP_HUES[SHIP_HUES.length - 1]);
    expect(ship.lights).toBe(SHIP_LIGHT_COMBOS[SHIP_LIGHT_COMBOS.length - 1]);
  });

  it("takes its direction from the random draw", () => {
    expect(makeShip(0, sequence(0.5, 0.2)).direction).toBe("ltr");
    expect(makeShip(0, sequence(0.5, 0.7)).direction).toBe("rtl");
  });

  it("keeps the hue and light combo in range", () => {
    for (const random of [() => 0, () => 0.999, () => 1, sequence(0.3, 0.6, 0.1, 0.9, 0.45)]) {
      const ship = makeShip(0, random);
      expect(SHIP_HUES).toContain(ship.hue);
      expect(SHIP_LIGHT_COMBOS).toContain(ship.lights);
    }
  });
});

describe("hitShip", () => {
  const targets = [target(1, 100, 50, 164, 74)];

  it("hits a point inside the box", () => {
    expect(hitShip(targets, 130, 60)).toBe(1);
  });

  it("hits a point within SHIP_HIT_PAD of the box", () => {
    expect(hitShip(targets, 100 - SHIP_HIT_PAD, 74 + SHIP_HIT_PAD)).toBe(1);
  });

  it("misses a point beyond the pad", () => {
    expect(hitShip(targets, 100 - SHIP_HIT_PAD - 1, 60)).toBeNull();
    expect(hitShip([], 0, 0)).toBeNull();
  });

  it("returns the first match when boxes overlap", () => {
    expect(hitShip([target(2, 0, 0, 50, 50), target(3, 20, 20, 80, 80)], 30, 30)).toBe(2);
  });
});

describe("makeShipBoom", () => {
  it("keeps the id, position and scale", () => {
    expect(makeShipBoom(5, 10, 20, 0.6, () => 0)).toMatchObject({
      id: 5,
      x: 10,
      y: 20,
      scale: 0.6,
    });
  });

  it("keeps the debris within SHIP_DEBRIS, its reach shrunk by scale", () => {
    for (const scale of [0.3, 1]) {
      const factor = 0.5 + 0.5 * scale;
      for (const random of [() => 0, () => 0.999, sequence(0.1, 0.7, 0.35, 0.9, 0.05)]) {
        const boom = makeShipBoom(0, 0, 0, scale, random);
        expect(boom.sparks.length).toBeGreaterThanOrEqual(SHIP_DEBRIS.countMin);
        expect(boom.sparks.length).toBeLessThanOrEqual(SHIP_DEBRIS.countMax);
        for (const spark of boom.sparks) {
          expect(spark.reach).toBeGreaterThanOrEqual(SHIP_DEBRIS.reachMin * factor);
          expect(spark.reach).toBeLessThanOrEqual(SHIP_DEBRIS.reachMax * factor);
          expect(spark.delay).toBeLessThanOrEqual(SHIP_DEBRIS.delayMax);
        }
      }
    }
  });
});
