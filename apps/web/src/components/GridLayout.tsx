import { Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { GridFadeContext, useGridFade } from "../grid-fade";
import { GridBackdrop } from "./GridBackdrop";

/**
 * The grid shared by Home, the task view and the Backlog. It stays mounted while moving between
 * them, so the drift never restarts. Its `fade` comes from the view on top via `useGridFade`.
 * `isolate` keeps the film within the pane and below portalled dialogs; the layout itself never
 * scrolls, its views do.
 */
export function GridLayout() {
  const [fade, setFade] = useState(true);
  return (
    <GridFadeContext.Provider value={setFade}>
      <div className="relative isolate h-full">
        <GridBackdrop fade={fade} />
        <Outlet />
      </div>
    </GridFadeContext.Provider>
  );
}

/**
 * The window the task view and the Backlog float in over the grid: 16px in from every edge, so the
 * grid shows around it, and above the film (`z-40`), so its text gets no grain or flicker. It stays
 * mounted between task and Backlog pages, so its flicker in (`.bw-window`, the archive crumble's
 * opacity stutter in reverse) plays only when it opens over the bare grid. The grid runs full width
 * around it.
 */
export function GridWindow() {
  useGridFade(false);
  return (
    <div className="bw-chamfer bw-window absolute inset-4 z-40 flex flex-col bg-background">
      <Outlet />
    </div>
  );
}
