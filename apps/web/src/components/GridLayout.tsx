import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { GridFadeContext, useGridFade } from "../grid-fade";
import { useEscapeTo } from "../keyboard";
import { windowExitTarget, windowOriginOf } from "../window-origin";
import { GridBackdrop } from "./GridBackdrop";
import { CloseIcon } from "./icons";
import { Button } from "./ui/button";

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
 * grid shows around it, and above the film (`z-40`), so its text gets no grain. It stays mounted
 * between task and Backlog pages, so its flicker in (`.bw-window`, the archive crumble's opacity
 * stutter in reverse) plays only when it opens over the bare grid. The grid runs full width around
 * it.
 * Slightly see-through in two layers: the window is `bg-background/92`, and the bars and side
 * panels that make up its structure are `bg-sidebar/40` on top (~95% stacked), so the scan line and
 * the film's flicker show faintly behind both. Inset cards stay opaque so their text reads cleanly.
 * Escape and the close button leave it: a Backlog for the grid, a task for the Backlog it was
 * opened from (window-origin.ts), else the grid.
 */
export function GridWindow() {
  useGridFade(false);
  const location = useLocation();
  const navigate = useNavigate();
  const leave = () => void navigate(windowExitTarget(location.pathname, windowOriginOf(location)));
  useEscapeTo(leave);
  return (
    <div className="bw-chamfer bw-window absolute inset-4 z-40 flex flex-col bg-background/92">
      <Outlet />
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-3 right-3 z-10"
        aria-label="Close"
        title="Close (Esc)"
        aria-keyshortcuts="Escape"
        onClick={leave}
      >
        <CloseIcon />
      </Button>
    </div>
  );
}
