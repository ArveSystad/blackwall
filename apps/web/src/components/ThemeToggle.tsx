import { useEffect, useRef, type PointerEvent } from "react";
import { cn } from "../lib/utils";
import { toggleTheme, toggleThemeLock, useTheme, useThemeLocked } from "../theme";
import { LockIcon, MoonIcon, SunIcon } from "./icons";
import { Button } from "./ui/button";

/** How long a press must be held to lock or unlock the theme. */
const LONG_PRESS_MS = 500;

/**
 * Header button that flips dark ↔ light until the device next switches. Shows what it switches
 * to; `T` does the same anywhere. Holding it locks the current theme against device switches, or
 * unlocks it again; a small lock shows while locked.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const locked = useThemeLocked();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  function clearTimer() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  useEffect(() => clearTimer, []);

  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("relative touch-none select-none [-webkit-touch-callout:none]", className)}
      aria-label={locked ? `${label}, theme locked` : label}
      aria-keyshortcuts="T"
      title={
        locked
          ? `${label} (T). Theme locked; hold to follow the device`
          : `${label} (T). Hold to lock the theme`
      }
      onPointerDown={(event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        longPressed.current = false;
        clearTimer();
        timer.current = setTimeout(() => {
          longPressed.current = true;
          toggleThemeLock();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearTimer}
      onPointerCancel={clearTimer}
      onPointerLeave={clearTimer}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        toggleTheme();
      }}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      {locked && <LockIcon size="sm" className="absolute right-0.5 bottom-0.5 size-2.5" />}
    </Button>
  );
}
