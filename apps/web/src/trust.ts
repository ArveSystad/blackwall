import {
  TRUSTED_LOADS_GLOBAL_CONFIG,
  type AgentCli,
  type AgentTrust,
  type AgentTrustLevel,
  type Step,
} from "@blackwall/shared";
import { CLI_NAMES } from "./settings-forms";

export const TRUST_NAMES: Record<AgentTrustLevel, string> = {
  locked: "Locked",
  trusted: "Trusted",
  unrestricted: "Unrestricted",
};

/** What a repo's agents can do at each level, one line each, for the settings form. */
export function trustRisk(level: AgentTrustLevel): string[] {
  if (level === "locked") {
    return [
      "Agents run in Blackwall's sandbox only: no repo skills, agents, MCP servers or hooks.",
    ];
  }
  if (level === "unrestricted") {
    return [
      "Every CLI runs in its own allow-everything mode: agents can run any command, push, change remotes and read anywhere.",
    ];
  }
  return [
    "Agents also load the repo's own skills, sub-agents and instruction files. Read-only agents keep Locked's permissions.",
    ...TRUSTED_LOADS_GLOBAL_CONFIG.map(
      (cli) =>
        `${CLI_NAMES[cli]} agents also load your own ${globalConfigDir(cli)} agents, skills and MCP servers.`,
    ),
  ];
}

function globalConfigDir(cli: AgentCli): string {
  return cli === "copilot" ? "~/.copilot" : cli === "claude" ? "~/.claude" : "~/.config/opencode";
}

/** The trust a task's agents run under, as its badge reads. */
export function trustLabel(trust: AgentTrust): string {
  switch (trust.forcedReason) {
    case "review":
      return "Locked (Review PR)";
    case "unchecked-branch":
      return "Locked until the branch is checked";
    case "foreign-branch":
      return "Locked (others' commits on branch)";
    case null:
      return TRUST_NAMES[trust.level];
  }
}

/** Whether to show a trust badge: always, except for a repo that is simply Locked. */
export function showsTrust(trust: AgentTrust): boolean {
  return trust.level !== "locked" || trust.forced;
}

/** Whether any of these steps ran Unrestricted, so the agents may already have pushed. */
export function ranUnrestricted(steps: readonly Pick<Step, "trust">[]): boolean {
  return steps.some((step) => step.trust === "unrestricted");
}

/** The note on a step whose CLI also loaded the user's own global config, or null. */
export function globalConfigNote(step: Pick<Step, "cli" | "trust">): string | null {
  if (!loadsGlobalConfig(step) || step.cli === null) return null;
  return `${CLI_NAMES[step.cli]} also loaded your own ${globalConfigDir(step.cli)} agents, skills and MCP servers.`;
}

/** Whether the step's CLI also loaded the user's own global config (see `TRUSTED_LOADS_GLOBAL_CONFIG`). */
export function loadsGlobalConfig(step: Pick<Step, "cli" | "trust">): boolean {
  return (
    step.trust === "trusted" && step.cli !== null && TRUSTED_LOADS_GLOBAL_CONFIG.includes(step.cli)
  );
}

/** The levels agent steps ran under that differ from the task's current trust. */
export function otherTrustLevels(
  steps: readonly Pick<Step, "trust">[],
  current: AgentTrust,
): AgentTrustLevel[] {
  const levels = new Set<AgentTrustLevel>();
  for (const step of steps) {
    if (step.trust && step.trust !== current.level) levels.add(step.trust);
  }
  return [...levels];
}

/** The skills a step's last `skills-loaded` event named; null when it has none. */
export function loadedSkills(
  events: readonly { type: string; payload: unknown }[],
): string[] | null {
  const event = events.findLast((e) => e.type === "skills-loaded");
  const skills = (event?.payload as { skills?: unknown } | undefined)?.skills;
  return Array.isArray(skills) ? skills.filter((s): s is string => typeof s === "string") : null;
}
