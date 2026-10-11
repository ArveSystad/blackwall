import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isBounds(value: unknown): value is Bounds {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => Number.isFinite(record[key]));
}

/** The saved window bounds; `undefined` when the file is missing or not valid JSON bounds. */
export function loadBounds(file: string): Bounds | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isBounds(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function saveBounds(file: string, bounds: Bounds): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(bounds)}\n`);
  } catch {
    // Losing the window position is not worth an error dialog.
  }
}

/** `saved` when it overlaps a display's work area, so the window never opens off-screen. */
export function visibleBounds(
  saved: Bounds | undefined,
  workAreas: readonly Bounds[],
): Bounds | undefined {
  if (!saved) return undefined;
  const intersects = (area: Bounds) =>
    saved.x < area.x + area.width &&
    saved.x + saved.width > area.x &&
    saved.y < area.y + area.height &&
    saved.y + saved.height > area.y;
  return workAreas.some(intersects) ? saved : undefined;
}
