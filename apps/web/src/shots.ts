/** How long a grid shot plays; mirrors the `.bw-shot` duration in styles.css. Change them together. */
export const SHOT_MS = 600;

/** Most shots on the grid at once; rapid clicking drops the oldest first. */
export const MAX_SHOTS = 8;

/** One shot fired at the grid wall, at `x`/`y` relative to the shots layer. */
export interface Shot {
  id: number;
  x: number;
  y: number;
}

/** `shots` with `shot` appended, keeping only the newest `MAX_SHOTS`. Does not mutate `shots`. */
export function addShot(shots: readonly Shot[], shot: Shot): Shot[] {
  return [...shots, shot].slice(-MAX_SHOTS);
}
