import type { AgentCli } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { CLI_NAMES } from "../settings-forms";

const TILES: Record<AgentCli, { mark: string; tone: string }> = {
  claude: { mark: "CC", tone: "text-claude bg-claude/18 border-claude/40" },
  copilot: { mark: "CP", tone: "text-copilot bg-copilot/18 border-copilot/40" },
};

/** Agent identity tile. CC/CP are placeholders until the real CLI marks are added. */
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
        "inline-flex flex-none items-center justify-center border font-mono font-bold tracking-[-0.02em]",
        size === "lg" ? "size-5 rounded-[5px] text-[10px]" : "size-4 rounded-sm text-[9px]",
        tile.tone,
        className,
      )}
    >
      {tile.mark}
    </span>
  );
}
