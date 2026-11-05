import { makeSparks, type Spark, type SparkRanges } from "./shots";

/** Gap between ship spawns, in ms: a fresh random gap after each one. */
export const SHIP_GAP_MIN_MS = 15_000;
export const SHIP_GAP_MAX_MS = 45_000;

/** Most ships in flight at once; a spawn while one flies is skipped. */
export const MAX_SHIPS = 1;

/**
 * How long a ship takes to cross, in ms: near ships are fast, far ones slow.
 * GridShots sets it as the inline `--ship-duration` of `.bw-ship`'s
 * `bw-ship-fly` (styles.css), and useShips drops the ship after it.
 */
export const SHIP_FLIGHT_MIN_MS = 14_000;
export const SHIP_FLIGHT_MAX_MS = 28_000;

/** Ship scale (`--ship-scale`) from far to near. */
export const SHIP_SCALE_MIN = 0.3;
export const SHIP_SCALE_MAX = 1;

/**
 * Ship height (`--ship-y`), as a % of the layer from its top. Far ships fly
 * just above the horizon (`.bw-grid-sky` ends at 58%), near ones high up.
 */
export const SHIP_Y_FAR = 48;
export const SHIP_Y_NEAR = 10;

/** Ship opacity from far to near. */
export const SHIP_OPACITY_FAR = 0.55;
export const SHIP_OPACITY_NEAR = 1;

/** Most a ship climbs or sinks over its flight, in px (`--ship-drift`). */
export const SHIP_DRIFT_MAX = 40;

/** Extra px around a ship's box that still counts as a hit. */
export const SHIP_HIT_PAD = 6;

/**
 * How long a ship's explosion lives; mirrors the 1.1s `.bw-ship-boom::before`
 * bloom in styles.css, the longest part (every other part ends transparent
 * sooner). Change them together.
 */
export const SHIP_BOOM_MS = 1100;

/**
 * A ship explosion's debris, before `makeShipBoom` scales the reach by depth.
 * The flight is the 700ms `.bw-ship-boom .bw-shot-spark` override in
 * styles.css; with the delay it ends by 780ms, inside `SHIP_BOOM_MS`.
 */
export const SHIP_DEBRIS: SparkRanges = {
  countMin: 16,
  countMax: 24,
  reachMin: 90,
  reachMax: 260,
  lengthMin: 10,
  lengthMax: 28,
  delayMax: 80,
};

/** Hull colours, from the app's neon palette (inline `--ship-color`). */
export const SHIP_HUES = [
  "var(--cyan)",
  "var(--magenta)",
  "var(--st-done)",
  "var(--st-failed)",
  "var(--sev-high)",
  "var(--st-interrupted)",
] as const;

/** Where a ship carries lights (`Spaceship.tsx`). */
export type ShipLightSlot = "nose" | "wingL" | "wingR" | "windows" | "engine";

/** Which slots are lit, and which of those blink. The engine always glows. */
export interface ShipLights {
  lit: readonly ShipLightSlot[];
  blink: readonly ShipLightSlot[];
}

export const SHIP_LIGHT_COMBOS: readonly ShipLights[] = [
  { lit: ["windows"], blink: [] },
  { lit: ["wingL", "wingR"], blink: ["wingL", "wingR"] },
  { lit: ["nose", "windows"], blink: ["nose"] },
  { lit: ["nose", "wingL", "wingR", "windows"], blink: ["wingL", "wingR"] },
  { lit: ["wingL", "wingR", "windows"], blink: ["engine"] },
];

/** One ship crossing the sky above the Home grid. */
export interface Ship {
  id: number;
  /** 0 far .. 1 near; everything below follows from it. */
  depth: number;
  scale: number;
  /** % of the layer from its top. */
  y: number;
  durationMs: number;
  opacity: number;
  direction: "ltr" | "rtl";
  /** px the ship climbs (negative) or sinks over its flight. */
  drift: number;
  hue: (typeof SHIP_HUES)[number];
  lights: ShipLights;
}

/** A downed ship's explosion, at `x`/`y` relative to the shots layer. */
export interface ShipBoom {
  id: number;
  x: number;
  y: number;
  /** The ship's scale, so far ships make smaller booms. */
  scale: number;
  sparks: Spark[];
}

/** A ship's box relative to the shots layer. */
export interface ShipTarget {
  id: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.min(items.length - 1, Math.floor(random() * items.length))] as T;

/** A random gap before the next spawn, within `SHIP_GAP_MIN_MS`..`SHIP_GAP_MAX_MS`. */
export function shipGapMs(random: () => number = Math.random): number {
  return lerp(SHIP_GAP_MIN_MS, SHIP_GAP_MAX_MS, random());
}

/** A ship at a random depth, direction, drift, hue and light combo. */
export function makeShip(id: number, random: () => number = Math.random): Ship {
  const depth = random();
  return {
    id,
    depth,
    scale: lerp(SHIP_SCALE_MIN, SHIP_SCALE_MAX, depth),
    y: lerp(SHIP_Y_FAR, SHIP_Y_NEAR, depth),
    durationMs: lerp(SHIP_FLIGHT_MAX_MS, SHIP_FLIGHT_MIN_MS, depth),
    opacity: lerp(SHIP_OPACITY_FAR, SHIP_OPACITY_NEAR, depth),
    direction: random() < 0.5 ? "ltr" : "rtl",
    drift: lerp(-SHIP_DRIFT_MAX, SHIP_DRIFT_MAX, random()),
    hue: pick(SHIP_HUES, random),
    lights: pick(SHIP_LIGHT_COMBOS, random),
  };
}

/** The id of the first target whose box, padded by `SHIP_HIT_PAD`, contains `x`/`y`; else null. */
export function hitShip(targets: readonly ShipTarget[], x: number, y: number): number | null {
  const hit = targets.find(
    (t) =>
      x >= t.left - SHIP_HIT_PAD &&
      x <= t.right + SHIP_HIT_PAD &&
      y >= t.top - SHIP_HIT_PAD &&
      y <= t.bottom + SHIP_HIT_PAD,
  );
  return hit ? hit.id : null;
}

/** An explosion at `x`/`y` with a `SHIP_DEBRIS` spray, its reach shrunk for far (small) ships. */
export function makeShipBoom(
  id: number,
  x: number,
  y: number,
  scale: number,
  random: () => number = Math.random,
): ShipBoom {
  const reach = 0.5 + 0.5 * scale;
  const sparks = makeSparks(random, SHIP_DEBRIS).map((spark) => ({
    ...spark,
    reach: spark.reach * reach,
  }));
  return { id, x, y, scale, sparks };
}
