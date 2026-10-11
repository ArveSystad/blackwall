import {
  OPENCODE_TOOLS,
  opencodeRuleSchema,
  type AgentCli,
  type PermissionOverrides,
  type PermissionProfile,
} from "@blackwall/shared";

/**
 * An agent's permissions for one step, as rules in its CLI's own syntax. Deny
 * rules always take precedence over allow rules in all three CLIs.
 */
export interface AgentPermissions {
  cli: AgentCli;
  profile: PermissionProfile;
  allow: string[];
  deny: string[];
}

/** Git commands a read-only agent may run: they only read history and the working tree. */
export const SAFE_GIT_COMMANDS = ["git diff", "git log", "git show", "git status"] as const;

/**
 * Commands that reach a remote or change remote configuration, plus the git
 * forms that could hide one (`git -C <dir> push`, `git -c alias.x=push x`, a
 * configured alias). Denied for every profile: the harness alone pushes, after
 * the user confirms.
 */
export const REMOTE_COMMANDS = [
  "git push",
  "git pull",
  "git fetch",
  "git remote",
  "git clone",
  "git ls-remote",
  "git submodule",
  "git config",
  "git -C",
  "git -c",
  "gh",
] as const;

/** Claude Code built-in tools available per profile (`--tools`); anything else is removed. */
const CLAUDE_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["Read", "Grep", "Glob", "Bash"],
  implement: ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Bash", "TodoWrite"],
};

const claudeBash = (command: string) => `Bash(${command}:*)`;

/** Copilot matches `git`/`gh` per first-level subcommand; `:*` also covers a bare stem. */
const copilotShell = (command: string) =>
  command.includes(" ") ? [`shell(${command})`] : [`shell(${command})`, `shell(${command}:*)`];

/** OpenCode matches a bash command against globs; the `*` also covers a bare stem. */
const opencodeBash = (command: string) => `bash(${command}*)`;

/** OpenCode tools no profile allows: web access, subagents (own config), skills, other dirs. */
const OPENCODE_DENIED = [
  "task",
  "webfetch",
  "websearch",
  "codesearch",
  "skill",
  "external_directory",
] as const;

const PROFILE_RULES: Record<
  AgentCli,
  Record<PermissionProfile, { allow: string[]; deny: string[] }>
> = {
  claude: {
    "read-only": {
      allow: ["Read", "Grep", "Glob", ...SAFE_GIT_COMMANDS.map(claudeBash)],
      deny: ["Edit", "Write", "NotebookEdit", ...REMOTE_COMMANDS.map(claudeBash)],
    },
    implement: {
      allow: [...CLAUDE_TOOLS.implement],
      deny: REMOTE_COMMANDS.map(claudeBash),
    },
  },
  copilot: {
    "read-only": {
      allow: SAFE_GIT_COMMANDS.flatMap(copilotShell),
      deny: ["write", ...REMOTE_COMMANDS.flatMap(copilotShell)],
    },
    implement: {
      allow: ["write", "shell"],
      deny: REMOTE_COMMANDS.flatMap(copilotShell),
    },
  },
  opencode: {
    "read-only": {
      allow: ["read", "grep", "glob", "list", ...SAFE_GIT_COMMANDS.map(opencodeBash)],
      deny: ["edit", ...OPENCODE_DENIED, ...REMOTE_COMMANDS.map(opencodeBash)],
    },
    implement: {
      allow: ["read", "grep", "glob", "list", "edit", "todowrite", "todoread", "bash(*)"],
      deny: [...OPENCODE_DENIED, ...REMOTE_COMMANDS.map(opencodeBash)],
    },
  },
};

function unique(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}

/**
 * Permissions for an agent working under a profile: the profile's rules for the
 * agent's CLI plus the agent's own overrides. Overrides can widen what a profile
 * allows (e.g. a test command for a reviewer) but never lift a profile's deny,
 * and a read-only Claude agent never gets the edit tools at all.
 */
export function permissionsFor(
  cli: AgentCli,
  profile: PermissionProfile,
  overrides: PermissionOverrides = {},
): AgentPermissions {
  const rules = PROFILE_RULES[cli][profile];
  return {
    cli,
    profile,
    allow: unique([...rules.allow, ...(overrides.allow ?? [])]),
    deny: unique([...rules.deny, ...(overrides.deny ?? [])]),
  };
}

/**
 * Command-line flags enforcing the permissions. All three CLIs run headless, so
 * any tool call not allowed is refused rather than prompted for, and all confine
 * file access to the working directory (the task's worktree).
 */
export function permissionArgs(permissions: AgentPermissions): string[] {
  const { cli, profile, allow, deny } = permissions;
  // OpenCode has no permission flags; its rules go in through config (`opencodeConfig`).
  if (cli === "opencode") return [];
  if (cli === "claude") {
    return [
      // Ignores user/project settings (and their allow rules), drops code-running
      // tools not named in --tools, and confines file tools to the working directory.
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--tools",
      CLAUDE_TOOLS[profile].join(","),
      "--allowedTools",
      allow.join(","),
      "--disallowedTools",
      deny.join(","),
    ];
  }
  return [
    "--no-ask-user",
    // The built-in GitHub MCP server can open PRs and post comments.
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    ...allow.map((rule) => `--allow-tool=${rule}`),
    ...deny.map((rule) => `--deny-tool=${rule}`),
  ];
}

type OpencodeAction = "allow" | "deny";

/** OpenCode's permission config: a top-level action per tool, and a pattern map for `bash`. */
export type OpencodePermission = Record<string, OpencodeAction | Record<string, OpencodeAction>>;

/** OpenCode config injected for a run (`OPENCODE_CONFIG_CONTENT`). */
export interface OpencodeConfig {
  permission: OpencodePermission;
  agent: { blackwall: { mode: "primary"; permission: OpencodePermission } };
  mcp: Record<string, never>;
  plugin: string[];
  share: "disabled";
}

/** A rule's bash glob, `null` for a bare tool key; throws on a rule outside the grammar. */
function opencodeRule(rule: string): { tool: string; pattern: string | null } {
  if (!opencodeRuleSchema.safeParse(rule).success) {
    throw new Error(`Not an OpenCode permission rule: ${rule}`);
  }
  const bash = /^bash\((.+)\)$/.exec(rule);
  return bash ? { tool: "bash", pattern: bash[1]! } : { tool: rule, pattern: null };
}

/**
 * OpenCode config enforcing the permissions. Everything starts denied (a
 * headless run never asks); a tool key is allowed only if an allow names it and
 * no deny does. In the `bash` map OpenCode applies the last matching pattern,
 * so the default comes first, then the allowed patterns, then every denied one:
 * a deny always wins, even over a bare `bash` allow. The run pins the injected
 * `blackwall` agent, so the built-in agents' permissions never apply.
 */
export function opencodeConfig({ cli, allow, deny }: AgentPermissions): OpencodeConfig {
  if (cli !== "opencode") throw new Error(`Permissions for ${cli} are not OpenCode rules`);
  const allowed = allow.map(opencodeRule);
  const denied = deny.map(opencodeRule);
  const permission: OpencodePermission = { "*": "deny" };
  for (const tool of OPENCODE_TOOLS) {
    if (tool === "bash") continue;
    const allows = allowed.some((r) => r.tool === tool && r.pattern === null);
    const denies = denied.some((r) => r.tool === tool);
    if (allows || denies) permission[tool] = allows && !denies ? "allow" : "deny";
  }
  const bareBashDenied = denied.some((r) => r.tool === "bash" && r.pattern === null);
  const bash: Record<string, OpencodeAction> = {
    "*":
      !bareBashDenied && allowed.some((r) => r.tool === "bash" && r.pattern === null)
        ? "allow"
        : "deny",
  };
  for (const { tool, pattern } of allowed) {
    if (tool === "bash" && pattern !== null && !bareBashDenied) bash[pattern] = "allow";
  }
  for (const { tool, pattern } of denied) {
    if (tool !== "bash" || pattern === null) continue;
    // Re-inserted so it lands after any allow of the same pattern.
    delete bash[pattern];
    bash[pattern] = "deny";
  }
  permission.bash = bash;
  return {
    permission,
    agent: { blackwall: { mode: "primary", permission } },
    mcp: {},
    plugin: [],
    share: "disabled",
  };
}
