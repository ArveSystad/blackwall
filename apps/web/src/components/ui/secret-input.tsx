import { useState, type ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { EyeIcon, EyeOffIcon } from "../icons";
import { Button } from "./button";
import { Input } from "./input";

/** Password-style input for tokens, with a toggle button that reveals the value. */
export function SecretInput({
  revealLabel = "Show token",
  className,
  ...props
}: ComponentProps<typeof Input> & { revealLabel?: string }) {
  const [reveal, setReveal] = useState(false);
  return (
    <span className="relative block">
      <Input
        className={cn("mono pr-9", className)}
        type={reveal ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-[3px] right-[3px]"
        aria-label={revealLabel}
        aria-pressed={reveal}
        onClick={() => setReveal((on) => !on)}
      >
        {reveal ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </span>
  );
}
