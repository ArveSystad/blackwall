import type { AgentCli, PermissionOverrides, PermissionProfile } from "@blackwall/shared";

/**
 * An agent's permissions for one step, as rules in its CLI's own syntax. Deny
 * rules always take precedence over allow rules in both CLIs.
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
 * Command-line flags enforcing the permissions. Both CLIs run headless, so any
 * tool call not allowed here is refused rather than prompted for, and both
 * confine file access to the working directory (the task's worktree).
 */
export function permissionArgs(permissions: AgentPermissions): string[] {
  const { cli, profile, allow, deny } = permissions;
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
