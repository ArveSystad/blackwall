import type { ReactNode } from "react";
import { SkylineContext, useSkylineLocator } from "./use-skyline";

/**
 * Keeps the home grid's tower locator for the shell, so effects outside the
 * grid can aim at a repo's tower; read with `useSkyline`.
 */
export function SkylineProvider({ children }: { children: ReactNode }) {
  const skyline = useSkylineLocator();
  return <SkylineContext.Provider value={skyline}>{children}</SkylineContext.Provider>;
}
