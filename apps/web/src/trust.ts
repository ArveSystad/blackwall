import {
  AGENT_CLIS,
  REMOTE_COMMANDS,
  SAFE_GIT_COMMANDS,
  TRUSTED_LOADS_GLOBAL_CONFIG,
  type AgentCli,
  type AgentTrust,
  type AgentTrustLevel,
  type Step,
  type TrustForcedReason,
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

// The trust help dialog's copy. It describes `permissionsFor` and the adapters in
// packages/core; update it when they change.

/**
 * The sub-agents an implementer may start, per CLI: see `CLAUDE_BUILTIN_SUBAGENTS`,
 * `COPILOT_EXCLUDED_TOOLS` and `OPENCODE_BUILTIN_SUBAGENTS` in core's permissions.
 */
export const IMPLEMENTER_SUBAGENTS: Record<AgentCli, string> = {
  claude: "only the Blackwall worker; built-in sub-agents are denied",
  copilot:
    "the Blackwall worker and Copilot's built-in sub-agents, which follow the same deny rules",
  opencode: "only the Blackwall worker; built-in sub-agents are denied",
};

/**
 * The sub-agents a read-only agent may start under Trusted, per CLI: see
 * `CLAUDE_TRUSTED_TOOLS`, `COPILOT_EXCLUDED_TOOLS` and `TRUSTED_RULES` in core's
 * permissions.
 */
export const READONLY_TRUSTED_SUBAGENTS: Record<AgentCli, string> = {
  claude: "the repo's sub-agents, built-ins denied",
  copilot: "none",
  opencode: "none",
};

/** The two permission profiles every agent runs under, before trust is applied. */
export const TRUST_PROFILES: {
  name: string;
  detail: string;
  subagentsLabel: string;
  subagents: Record<AgentCli, string>;
}[] = [
  {
    name: "Read-only",
    detail: `Planners, reviewers and chat. They read files and run ${SAFE_GIT_COMMANDS.join(", ")}; they never edit. No sub-agents under Locked.`,
    subagentsLabel: "Sub-agents under Trusted",
    subagents: READONLY_TRUSTED_SUBAGENTS,
  },
  {
    name: "Implement",
    detail: "Implementers. They read, edit and write files and run any shell command.",
    subagentsLabel: "Sub-agents",
    subagents: IMPLEMENTER_SUBAGENTS,
  },
];

export const TRUST_PROFILE_NOTE = "Trust is applied on top of the profile.";

/** Each CLI's allow-everything mode, which Unrestricted runs it in. */
export const ALLOW_EVERYTHING_MODES: Record<AgentCli, string> = {
  claude: "bypassPermissions",
  copilot: "--allow-all",
  opencode: "*: allow",
};

/** A per-CLI record as one line, CLIs with the same text grouped: `A: x; B, C: y`. */
export function perCli(record: Record<AgentCli, string>): string {
  const groups = new Map<string, AgentCli[]>();
  for (const cli of AGENT_CLIS) {
    groups.set(record[cli], [...(groups.get(record[cli]) ?? []), cli]);
  }
  return [...groups]
    .map(([text, clis]) => `${clis.map((cli) => CLI_NAMES[cli]).join(", ")}: ${text}`)
    .join("; ");
}

/** The help dialog's paragraphs on one level. */
export function trustDetail(level: AgentTrustLevel): string[] {
  if (level === "locked") {
    return [
      "Blackwall's sandbox only: no repo skills, sub-agents, MCP servers or hooks.",
      "Agents stay in the worktree; read-only agents may also read the repo's reference repos.",
      "No web fetch or search.",
    ];
  }
  if (level === "unrestricted") {
    return [
      "No rules at all: per-agent allow and deny overrides are ignored too.",
      `Each CLI runs in its allow-everything mode: ${AGENT_CLIS.map((cli) => `${CLI_NAMES[cli]} ${ALLOW_EVERYTHING_MODES[cli]}`).join(", ")}.`,
      "Agents can push, change remotes, run any command and read anywhere.",
    ];
  }
  return [
    "Locked, plus the repo's own skills, sub-agents and instruction files (AGENTS.md, CLAUDE.md).",
    `Read-only agents keep Locked's tool and command permissions. Sub-agents they can start: ${perCli(READONLY_TRUSTED_SUBAGENTS)}. ${CLI_NAMES.claude} read-only agents also run under a guard hook that holds their shell commands to the read-only list.`,
    "Implementers can also start the repo's sub-agents, on every CLI.",
    "The repo's MCP servers and hooks reach implementers only, and only when their checkboxes are on.",
    ...TRUSTED_LOADS_GLOBAL_CONFIG.map(
      (cli) =>
        `${CLI_NAMES[cli]} also loads your own ${globalConfigDir(cli)} agents, skills and MCP servers.`,
    ),
  ];
}

/** One help-table cell: one text, or one per profile where they differ. */
export type TrustCell = string | { readOnly: string; implement: string };

/**
 * What each level allows, for the help dialog's table. Mirrors `permissionsFor`,
 * `TRUSTED_RULES`, `OPENCODE_DENIED` and `COPILOT_EXCLUDED_TOOLS` in core.
 */
export const TRUST_MATRIX: { capability: string; cells: Record<AgentTrustLevel, TrustCell> }[] = [
  {
    capability: "Edit and write files",
    cells: {
      locked: { readOnly: "no", implement: "yes" },
      trusted: { readOnly: "no", implement: "yes" },
      unrestricted: "yes",
    },
  },
  {
    capability: "Shell commands",
    cells: {
      locked: { readOnly: "safe git only", implement: "any except remote" },
      trusted: "same as Locked",
      unrestricted: "any",
    },
  },
  {
    capability: "Remote git and gh",
    cells: { locked: "denied", trusted: "denied", unrestricted: "allowed" },
  },
  {
    capability: "Sub-agents",
    cells: {
      locked: {
        readOnly: "none",
        implement: `Blackwall worker (${CLI_NAMES.copilot}: also its built-ins, same denies)`,
      },
      trusted: {
        readOnly: perCli(READONLY_TRUSTED_SUBAGENTS),
        implement: "Locked's plus the repo's sub-agents",
      },
      unrestricted: "any",
    },
  },
  {
    capability: "Repo skills, sub-agents, instruction files",
    cells: { locked: "no", trusted: "yes", unrestricted: "yes" },
  },
  {
    capability: "Repo MCP servers and hooks",
    cells: {
      locked: "no",
      trusted: { readOnly: "no", implement: "when turned on" },
      unrestricted: "yes",
    },
  },
  {
    capability: "Files outside the worktree",
    cells: {
      locked: { readOnly: "reference repos only", implement: "none" },
      trusted: "same as Locked",
      unrestricted: "anywhere",
    },
  },
  {
    capability: "Web fetch and search",
    cells: { locked: "no", trusted: "no", unrestricted: "yes" },
  },
  {
    capability: "Per-agent allow/deny overrides",
    cells: { locked: "applied", trusted: "applied", unrestricted: "ignored" },
  },
];

/** Commands denied to every agent under Locked and Trusted. */
export function alwaysDeniedCommands(): readonly string[] {
  return REMOTE_COMMANDS;
}

export const ALWAYS_DENIED_NOTE =
  "Only Blackwall pushes, after you confirm. These rules bind every sub-agent too.";

/** Why a task runs Locked although its repo is set higher, in the help dialog. */
export const FORCED_LOCKED_HELP: Record<TrustForcedReason, string> = {
  review: "Review PR tasks: they read code someone else wrote.",
  "foreign-branch": "PR tasks whose PR, or a commit on its branch, isn't yours.",
  "unchecked-branch":
    "PR tasks whose branch isn't checked yet, or whose check failed or wasn't recorded.",
};

export const FORCED_LOCKED_NOTES = [
  "Forcing only lowers a repo set above Locked.",
  "The chat always runs Locked.",
];

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
