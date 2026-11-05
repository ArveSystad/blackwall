import type { CSSProperties } from "react";
import type { ShipLightSlot, ShipLights } from "../ships";

/** Where each light slot sits in the 64×24 viewBox; the nose points right. */
const SLOTS: Record<Exclude<ShipLightSlot, "engine">, readonly (readonly [number, number])[]> = {
  nose: [[60.5, 12]],
  wingL: [[11, 2.5]],
  wingR: [[11, 21.5]],
  windows: [
    [22, 12],
    [28, 12],
    [34, 12],
  ],
};

/** Blink offsets per slot, so lights never pulse in lockstep. */
const BLINK_DELAY: Record<ShipLightSlot, string> = {
  nose: "0s",
  wingL: "0.2s",
  wingR: "0.8s",
  windows: "0.4s",
  engine: "0.1s",
};

const blinkClass = (lights: ShipLights, slot: ShipLightSlot) =>
  lights.blink.includes(slot) ? " bw-ship-light-blink" : "";

/**
 * One spaceship silhouette for GridShots' passing ships: a hull, cockpit and
 * fins in `--ship-color` (`.bw-ship-*` in styles.css), an engine that always
 * glows, and the lights `lights` turns on (some blinking).
 */
export function Spaceship({ lights }: { lights: ShipLights }) {
  return (
    <svg viewBox="0 0 64 24" aria-hidden="true" focusable="false">
      <path className="bw-ship-fin" d="M15 6.5 9 1h11l7 5.5Z" />
      <path className="bw-ship-fin" d="M15 17.5 9 23h11l7-5.5Z" />
      <path className="bw-ship-hull" d="M5 12 14 6.5 40 5l16 4 6 3-6 3-16 4-26-1.5Z" />
      <ellipse className="bw-ship-cockpit" cx="45" cy="10.5" rx="7" ry="2.75" />
      <ellipse
        className={`bw-ship-engine${blinkClass(lights, "engine")}`}
        style={{ "--blink-delay": BLINK_DELAY.engine } as CSSProperties}
        cx="4"
        cy="12"
        rx="3"
        ry="2.5"
      />
      {(Object.keys(SLOTS) as (keyof typeof SLOTS)[])
        .filter((slot) => lights.lit.includes(slot))
        .flatMap((slot) =>
          SLOTS[slot].map(([cx, cy]) => (
            <circle
              key={`${slot}-${cx}`}
              className={`bw-ship-light${blinkClass(lights, slot)}`}
              style={{ "--blink-delay": BLINK_DELAY[slot] } as CSSProperties}
              cx={cx}
              cy={cy}
              r={slot === "windows" ? 1.1 : 1.4}
            />
          )),
        )}
    </svg>
  );
}
