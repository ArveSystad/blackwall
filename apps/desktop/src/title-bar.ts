/** Height of the OS button overlay; the web app's strip adds 1px for its hairline. */
export const TITLE_BAR_HEIGHT = 32;

// Mirror `--bg-0` in apps/web/src/styles.css (dark and light). Change them together.
export const DARK_CANVAS = "#0a0918";
export const LIGHT_CANVAS = "#f3f3f6";

// Mirror `--fg-strong` in apps/web/src/styles.css.
const LIGHT_SYMBOLS = "#ebe8f7";
const DARK_SYMBOLS = "#111118";

export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

/** Relative luminance (WCAG) of a `#rrggbb` colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Overlay options for the page's `theme-color`: its canvas behind the buttons, with symbols that
 * contrast with it. No colour, or anything but `#rrggbb`, gives the dark overlay.
 */
export function titleBarOverlay(color: string | null): TitleBarOverlay {
  if (color === null || !/^#[0-9a-f]{6}$/i.test(color)) {
    return { color: DARK_CANVAS, symbolColor: LIGHT_SYMBOLS, height: TITLE_BAR_HEIGHT };
  }
  return {
    color,
    symbolColor: luminance(color) > 0.5 ? DARK_SYMBOLS : LIGHT_SYMBOLS,
    height: TITLE_BAR_HEIGHT,
  };
}
