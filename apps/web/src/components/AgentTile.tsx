import type { AgentCli } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { CLI_NAMES } from "../settings-forms";

const TILES: Record<AgentCli, { mark: string; tone: string }> = {
  claude: {
    mark: "CC",
    tone: "text-claude bg-claude/18 [--bw-chamfer-line:color-mix(in_oklab,var(--claude)_40%,transparent)]",
  },
  copilot: {
    mark: "CP",
    tone: "text-copilot bg-copilot/18 [--bw-chamfer-line:color-mix(in_oklab,var(--copilot)_40%,transparent)]",
  },
  opencode: {
    mark: "OC",
    tone: "text-opencode bg-opencode/18 [--bw-chamfer-line:color-mix(in_oklab,var(--opencode)_40%,transparent)]",
  },
};

/** Agent identity tile. CC/CP/OC are placeholders until the real CLI marks are added. */
export function AgentTile({
  cli,
  size = "md",
  className,
}: {
  cli: AgentCli;
  size?: "md" | "lg";
  className?: string;
}) {
  const tile = TILES[cli];
  const name = CLI_NAMES[cli];
  return (
    <span
      title={name}
      aria-label={name}
      role="img"
      className={cn(
        "bw-chamfer inline-flex flex-none items-center justify-center font-mono font-bold tracking-[-0.02em]",
        size === "lg" ? "size-5 text-[10px] [--bw-cut:4px]" : "size-4 text-[9px] [--bw-cut:3px]",
        tile.tone,
        className,
      )}
    >
      {tile.mark}
    </span>
  );
}
