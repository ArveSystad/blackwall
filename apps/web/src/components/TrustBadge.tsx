import type { AgentTrust } from "@blackwall/shared";
import { cn } from "../lib/utils";
import { showsTrust, trustLabel } from "../trust";
import { WarnIcon } from "./icons";
import { Chip } from "./ui/chip";

/**
 * The trust a task's agents run under (or a repo's setting): nothing for a repo that is simply
 * Locked, a neutral chip for Trusted and for a forced Locked (saying why), and a warning for
 * Unrestricted, whose agents may do anything.
 */
export function TrustBadge({ trust, className }: { trust: AgentTrust; className?: string }) {
  if (!showsTrust(trust)) return null;
  const unrestricted = trust.level === "unrestricted";
  const label = trustLabel(trust);
  return (
    <Chip
      tone={unrestricted ? "failed" : "neutral"}
      className={cn("gap-1 whitespace-nowrap", className)}
      title={`Agent trust: ${label}`}
    >
      {unrestricted && <WarnIcon size="sm" />}
      {label}
    </Chip>
  );
}
