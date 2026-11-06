import { createContext, useCallback, useContext, useMemo, useRef } from "react";

/** Where a repo's tower stands on the home grid, in the same overlay pixels as the dots. */
export interface TowerSpot {
  /** The tower's centre. */
  x: number;
  /** The roof. */
  top: number;
  /** The horizon it stands on. */
  base: number;
  width: number;
}

/** Where a repo's tower stands, if the home grid shows it. */
export type LocateTower = (repoId: string) => TowerSpot | undefined;

/** The home grid's repo skyline, for effects that aim at a tower; see `useSkylineLocator`. */
export interface Skyline {
  /** Where the repo's tower stands; undefined when Home is not showing the agents. */
  locateTower: LocateTower;
  /** Sets the tower locator; `GridAgents` sets it while mounted. */
  setLocate: (locate: LocateTower | null) => void;
}

export const SkylineContext = createContext<Skyline | null>(null);

/** The shell's skyline locator; see `SkylineProvider`. */
export function useSkyline(): Skyline {
  const skyline = useContext(SkylineContext);
  if (!skyline) throw new Error("useSkyline needs a SkylineProvider");
  return skyline;
}

/**
 * A ref-backed tower locator, kept by the shell route so effects anywhere in
 * it can find a repo's tower while the home grid shows it.
 */
export function useSkylineLocator(): Skyline {
  const locate = useRef<LocateTower | null>(null);
  const setLocate = useCallback((next: LocateTower | null) => {
    locate.current = next;
  }, []);
  const locateTower = useCallback<LocateTower>((repoId) => locate.current?.(repoId), []);
  return useMemo(() => ({ locateTower, setLocate }), [locateTower, setLocate]);
}
