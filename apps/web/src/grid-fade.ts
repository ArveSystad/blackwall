import { createContext, useContext, useLayoutEffect } from "react";

/** Sets the shared grid's `fade` (GridLayout.tsx). A no-op outside the grid layout. */
export const GridFadeContext = createContext<(fade: boolean) => void>(() => {});

/**
 * Sets the fade of the grid behind the current view. Runs in a layout effect, so no frame paints
 * with the previous view's fade.
 */
export function useGridFade(fade: boolean): void {
  const setFade = useContext(GridFadeContext);
  useLayoutEffect(() => setFade(fade), [setFade, fade]);
}
