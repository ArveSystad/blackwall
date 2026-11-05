/**
 * How long a grid shot lives; mirrors the 1.5s `.bw-shot-mark` fade in
 * styles.css, the longest part of a shot (every other part ends transparent
 * sooner). Change them together.
 */
export const SHOT_MS = 1500;

/** Most shots on the grid at once; at full auto-fire ~14 are alive, so the cap never shows. */
export const MAX_SHOTS = 24;

/** Spark count per shot. */
export const SPARKS_MIN = 6;
export const SPARKS_MAX = 10;
/**
 * How far a spark flies, in px. The flight is the 360ms `.bw-shot-spark`
 * animation in styles.css, which reads these through `--spark-reach`.
 */
export const SPARK_REACH_MIN = 28;
export const SPARK_REACH_MAX = 90;
/** Spark streak length, in px (`--spark-length`). */
export const SPARK_LENGTH_MIN = 6;
export const SPARK_LENGTH_MAX = 16;
/** Most a spark's start lags the shot, in ms (`--spark-delay`). */
export const SPARK_DELAY_MAX = 30;

/** Time between shots while the button is held: ~9 shots a second. */
export const AUTO_FIRE_MS = 110;

/**
 * How long the recoil cursor (`.bw-shoot[data-recoil]` in styles.css) shows
 * after each shot. A cursor can't be animated, so a timer swaps it back.
 */
export const RECOIL_MS = 80;

/**
 * Name of the bubbling DOM `CustomEvent<ShotEventDetail>` GridShots
 * dispatches per shot, so GridBackdrop can flare and shake the grid there.
 */
export const SHOT_EVENT = "bw-shot";

export interface ShotEventDetail {
  clientX: number;
  clientY: number;
}

/** One spark streak flying out of a shot, at `angle` degrees. */
export interface Spark {
  angle: number;
  reach: number;
  length: number;
  delay: number;
}

/** One shot fired at the grid wall, at `x`/`y` relative to the shots layer. */
export interface Shot {
  id: number;
  x: number;
  y: number;
  /** Rotation of the star-shaped flash and the impact cracks, in degrees. */
  angle: number;
  sparks: Spark[];
}

/** The count, reach, length and delay ranges of a spark spray. */
export interface SparkRanges {
  countMin: number;
  countMax: number;
  reachMin: number;
  reachMax: number;
  lengthMin: number;
  lengthMax: number;
  delayMax: number;
}

/** A grid shot's spark spray. */
export const SHOT_SPARKS: SparkRanges = {
  countMin: SPARKS_MIN,
  countMax: SPARKS_MAX,
  reachMin: SPARK_REACH_MIN,
  reachMax: SPARK_REACH_MAX,
  lengthMin: SPARK_LENGTH_MIN,
  lengthMax: SPARK_LENGTH_MAX,
  delayMax: SPARK_DELAY_MAX,
};

const between = (random: () => number, min: number, max: number) => min + random() * (max - min);

/** A random spray of sparks within `ranges` (a grid shot's by default). */
export function makeSparks(
  random: () => number = Math.random,
  ranges: SparkRanges = SHOT_SPARKS,
): Spark[] {
  const count = ranges.countMin + Math.floor(random() * (ranges.countMax - ranges.countMin + 1));
  return Array.from({ length: count }, () => ({
    angle: random() * 360,
    reach: between(random, ranges.reachMin, ranges.reachMax),
    length: between(random, ranges.lengthMin, ranges.lengthMax),
    delay: random() * ranges.delayMax,
  }));
}

/** A shot at `x`/`y` with a random flash rotation and spark spray. */
export function makeShot(
  id: number,
  x: number,
  y: number,
  random: () => number = Math.random,
): Shot {
  return { id, x, y, angle: random() * 360, sparks: makeSparks(random) };
}

/** `shots` with `shot` appended, keeping only the newest `MAX_SHOTS`. Does not mutate `shots`. */
export function addShot(shots: readonly Shot[], shot: Shot): Shot[] {
  return [...shots, shot].slice(-MAX_SHOTS);
}

/** A held trigger: where it aims and when it last fired (a `performance.now()` time). */
export interface Trigger {
  x: number;
  y: number;
  lastShotAt: number;
}

/** A trigger pulled at `x`/`y`; the first shot fires at once, at `now`. */
export function pullTrigger(x: number, y: number, now: number): Trigger {
  return { x, y, lastShotAt: now };
}

/** `trigger` aimed at `x`/`y`, keeping its cadence. */
export function aimTrigger(trigger: Trigger, x: number, y: number): Trigger {
  return { ...trigger, x, y };
}

/**
 * Whether a held trigger fires at `now`: once `AUTO_FIRE_MS` has passed since
 * the last shot. At most one shot per call; after a stalled frame the cadence
 * resumes from `now` instead of firing a burst to catch up.
 */
export function advanceTrigger(trigger: Trigger, now: number): { trigger: Trigger; fire: boolean } {
  if (now - trigger.lastShotAt < AUTO_FIRE_MS) return { trigger, fire: false };
  // Late by less than an interval (frame jitter): keep the steady cadence.
  // Later (a stall): restart it from now.
  const late = now - trigger.lastShotAt >= 2 * AUTO_FIRE_MS;
  const lastShotAt = late ? now : trigger.lastShotAt + AUTO_FIRE_MS;
  return { trigger: { ...trigger, lastShotAt }, fire: true };
}
