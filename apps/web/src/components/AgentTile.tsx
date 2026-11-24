import type { AgentCli } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { agentTileLabel } from "../settings-forms";

const TILES: Record<AgentCli, { mark: string; tone: string; accent: string }> = {
  claude: {
    mark: "CC",
    tone: "text-claude bg-claude/18 [--bw-chamfer-line:color-mix(in_oklab,var(--claude)_40%,transparent)]",
    accent: "text-claude",
  },
  copilot: {
    mark: "CP",
    tone: "text-copilot bg-copilot/18 [--bw-chamfer-line:color-mix(in_oklab,var(--copilot)_40%,transparent)]",
    accent: "text-copilot",
  },
  opencode: {
    mark: "OC",
    tone: "text-opencode bg-opencode/18 [--bw-chamfer-line:color-mix(in_oklab,var(--opencode)_40%,transparent)]",
    accent: "text-opencode",
  },
};

/**
 * Agent identity tile. CC/CP/OC are placeholders until the real CLI marks are added.
 * `envNames` are the variables the task's repo sets for this CLI (see `cliEnvNames`):
 * when any are set, a small glowing `*` marks the top-right corner and the tooltip
 * lists their names, never their values. The marker sits on an unclipped wrapper,
 * outside the chamfer clip, and takes no layout space.
 */
export function AgentTile({
  cli,
  size = "md",
  envNames,
  className,
}: {
  cli: AgentCli;
  size?: "md" | "lg";
  envNames?: readonly string[];
  className?: string;
}) {
  const tile = TILES[cli];
  const custom = envNames !== undefined && envNames.length > 0;
  const label = agentTileLabel(cli, custom ? envNames : []);
  const body = cn(
    "bw-chamfer inline-flex flex-none items-center justify-center font-mono font-bold tracking-[-0.02em]",
    size === "lg" ? "size-5 text-[10px] [--bw-cut:4px]" : "size-4 text-[9px] [--bw-cut:3px]",
    tile.tone,
  );
  if (!custom) {
    return (
      <span title={label} aria-label={label} role="img" className={cn(body, className)}>
        {tile.mark}
      </span>
    );
  }
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={cn("relative inline-flex flex-none", className)}
    >
      <span className={body}>{tile.mark}</span>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute font-mono font-bold leading-none [text-shadow:0_0_3px_currentColor]",
          size === "lg"
            ? "-top-[4px] -right-[4px] text-[10px]"
            : "-top-[3px] -right-[3px] text-[9px]",
          tile.accent,
        )}
      >
        *
      </span>
    </span>
  );
}
