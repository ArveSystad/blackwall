import { toggleTheme, useTheme } from "../theme";
import { MoonIcon, SunIcon } from "./icons";
import { Button } from "./ui/button";

/** Header button that flips dark ↔ light. Shows what it switches to; `T` does the same anywhere. */
export function ThemeToggle() {
  const theme = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-keyshortcuts="T"
      title={`${label} (T)`}
      onClick={() => toggleTheme()}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </Button>
  );
}
