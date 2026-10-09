import { toggleTheme, useTheme } from "../theme";
import { MoonIcon, SunIcon } from "./icons";
import { Button } from "./ui/button";

/** Header button that flips dark ↔ light. Shows what it switches to; `T` does the same anywhere. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Button
      variant="ghost"
      size="icon"
      className={className}
      aria-label={label}
      aria-keyshortcuts="T"
      title={`${label} (T)`}
      onClick={() => toggleTheme()}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
