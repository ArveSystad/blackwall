import { fileURLToPath } from "node:url";
import {
  LOCKED_TRUST,
  OPENCODE_TOOLS,
  opencodeRuleSchema,
  type AgentCli,
  type AgentTrust,
  type PermissionOverrides,
  type PermissionProfile,
} from "@blackwall/shared";
import { opencodeSubagent, SUBAGENT_NAME } from "./subagents.js";

/**
 * An agent's permissions for one step, as rules in its CLI's own syntax. Deny
 * rules always take precedence over allow rules in all three CLIs.
 */
export interface AgentPermissions {
  cli: AgentCli;
  profile: PermissionProfile;
  allow: string[];
  deny: string[];
  /**
   * Folders outside the working directory the agent may read: the repo's
   * reference repos. Always empty for implementers.
   */
  readDirs: string[];
  /**
   * The trust the step runs under. Locked is the harness sandbox; Trusted adds
   * the repo's skills and agents (and, for implementers only, its MCP servers
   * and hooks when turned on); Unrestricted drops every rule.
   */
  trust: AgentTrust;
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

/**
 * Claude Code built-in tools available per profile (`--tools`); anything else is
 * removed. Implementers get `Agent` for the harness-defined worker only: see
 * {@link CLAUDE_BUILTIN_SUBAGENTS}.
 */
const CLAUDE_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["Read", "Grep", "Glob", "Bash"],
  implement: [
    "Read",
    "Grep",
    "Glob",
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash",
    "TodoWrite",
    "Agent",
  ],
};

/**
 * Claude Code tools added under Trusted: `Skill` for the repo's skills, and,
 * for read-only agents, `Agent` for the repo's sub-agents (implementers have it
 * already). The built-in sub-agents stay denied.
 */
const CLAUDE_TRUSTED_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["Skill", "Agent"],
  implement: ["Skill"],
};

/**
 * Claude Code's built-in sub-agent types (as listed in its `init` line), all
 * denied. Claude Code runs any sub-agent type without an allow rule, so an
 * `Agent(<name>)` allow alone does not keep implementers to the worker.
 */
const CLAUDE_BUILTIN_SUBAGENTS = [
  "general-purpose",
  "Explore",
  "Plan",
  "claude",
  "statusline-setup",
] as const;

/**
 * Copilot tools removed per profile (`--excluded-tools`). Copilot runs its
 * `task` tool (sub-agents) without asking, and a `--deny-tool=task` rule does
 * not stop it, so reviewers lose the tool itself. Implementers keep it: every
 * sub-agent, the harness-defined worker or a built-in one, inherits the run's
 * allow and deny rules.
 */
const COPILOT_EXCLUDED_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["task"],
  implement: [],
};

/**
 * Copilot loads the repo's skills by itself whenever the user trusts the
 * folder (its `trustedFolders`, often a parent such as `C:\Code`), so Locked
 * removes the `skill` tool itself. A skill's `allowed-tools` grants Copilot
 * nothing, so Trusted keeps the tool for every profile.
 */
const COPILOT_LOCKED_EXCLUDED_TOOLS = ["skill"] as const;

const claudeBash = (command: string) => `Bash(${command}:*)`;

/** Copilot matches `git`/`gh` per first-level subcommand; `:*` also covers a bare stem. */
const copilotShell = (command: string) =>
  command.includes(" ") ? [`shell(${command})`] : [`shell(${command})`, `shell(${command}:*)`];

/**
 * OpenCode matches a bash command against globs whose `*` matches any
 * characters, so an allow must end at a word boundary: the bare command or the
 * command plus arguments, never `git difftool` for `git diff`.
 */
const opencodeAllow = (command: string) => [`bash(${command})`, `bash(${command} *)`];

/** A deny stays broad so it fails closed: `git push*` also catches `git pushx`. */
const opencodeDeny = (command: string) => `bash(${command}*)`;

/**
 * OpenCode tools no profile allows: web access, and skills unless the repo is
 * Trusted (see {@link TRUSTED_RULES}). Other dirs
 * (`external_directory`) are denied by `opencodeConfig` unless the permissions
 * list `readDirs`.
 */
const OPENCODE_DENIED = ["webfetch", "websearch", "codesearch", "skill"] as const;

/**
 * OpenCode's built-in sub-agents, all denied: they run on the parent's model,
 * and a user's bare `task` allow must not open them.
 */
const OPENCODE_BUILTIN_SUBAGENTS = ["general", "explore"] as const;

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
      // Only the harness-defined worker, never the built-in sub-agents (which
      // run on the parent's model). The deny rules bind the worker too.
      allow: [
        "Read",
        "Grep",
        "Glob",
        "Edit",
        "Write",
        "NotebookEdit",
        "Bash",
        "TodoWrite",
        `Agent(${SUBAGENT_NAME})`,
      ],
      deny: [
        ...CLAUDE_BUILTIN_SUBAGENTS.map((name) => `Agent(${name})`),
        ...REMOTE_COMMANDS.map(claudeBash),
      ],
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
      allow: ["read", "grep", "glob", "list", ...SAFE_GIT_COMMANDS.flatMap(opencodeAllow)],
      deny: ["edit", "task", ...OPENCODE_DENIED, ...REMOTE_COMMANDS.map(opencodeDeny)],
    },
    implement: {
      // As for Claude: only the harness-defined worker, never the built-in sub-agents.
      allow: [
        "read",
        "grep",
        "glob",
        "list",
        "edit",
        "todowrite",
        "todoread",
        "bash(*)",
        `task(${SUBAGENT_NAME})`,
      ],
      deny: [
        ...OPENCODE_DENIED,
        ...OPENCODE_BUILTIN_SUBAGENTS.map((name) => `task(${name})`),
        ...REMOTE_COMMANDS.map(opencodeDeny),
      ],
    },
  },
};

interface TrustedRules {
  allow: readonly string[];
  deny: readonly string[];
  /** Profile denies Trusted lifts; never a {@link REMOTE_COMMANDS} or edit deny. */
  lift: readonly string[];
}

const NO_TRUSTED_RULES: TrustedRules = { allow: [], deny: [], lift: [] };

/**
 * What Trusted changes in a profile's rules. The skill tool comes into reach,
 * and a read-only Claude agent, which gets `Agent` for the repo's sub-agents,
 * has the built-in sub-agents denied as implementers do. Every other deny of
 * the profile stays.
 */
const TRUSTED_RULES: Record<AgentCli, Record<PermissionProfile, TrustedRules>> = {
  claude: {
    "read-only": {
      allow: ["Skill"],
      deny: CLAUDE_BUILTIN_SUBAGENTS.map((name) => `Agent(${name})`),
      lift: [],
    },
    implement: { allow: ["Skill"], deny: [], lift: [] },
  },
  copilot: { "read-only": NO_TRUSTED_RULES, implement: NO_TRUSTED_RULES },
  opencode: {
    "read-only": { allow: ["skill"], deny: [], lift: ["skill"] },
    implement: { allow: ["skill"], deny: [], lift: ["skill"] },
  },
};

function unique(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}

/**
 * Permissions for an agent working under a profile: the profile's rules for the
 * agent's CLI plus the agent's own overrides. Overrides can widen what a profile
 * allows (e.g. a test command for a reviewer) but never lift a profile's deny,
 * and a read-only Claude agent never gets the edit tools at all. `readDirs`
 * (the reference repos) are kept only for the read-only profile, so only the
 * harness ever writes outside the worktree. Under Trusted the skill tool comes
 * into reach (see {@link TRUSTED_RULES}); under Unrestricted there are no rules
 * at all, overrides included.
 */
export function permissionsFor(
  cli: AgentCli,
  profile: PermissionProfile,
  overrides: PermissionOverrides = {},
  readDirs: readonly string[] = [],
  trust: AgentTrust = LOCKED_TRUST,
): AgentPermissions {
  const dirs = profile === "read-only" ? unique(readDirs) : [];
  if (trust.level === "unrestricted") {
    return { cli, profile, allow: [], deny: [], readDirs: dirs, trust };
  }
  const rules = PROFILE_RULES[cli][profile];
  const extra = trust.level === "trusted" ? TRUSTED_RULES[cli][profile] : NO_TRUSTED_RULES;
  return {
    cli,
    profile,
    allow: unique([...rules.allow, ...extra.allow, ...(overrides.allow ?? [])]),
    deny: unique([
      ...rules.deny.filter((rule) => !extra.lift.includes(rule)),
      ...extra.deny,
      ...(overrides.deny ?? []),
    ]),
    readDirs: dirs,
    trust,
  };
}

/**
 * The Bash command prefixes a read-only Claude agent may run, from its
 * `Bash(<prefix>:*)` and `Bash(<command>)` allow rules; a bare `Bash` allow
 * becomes `*` (any command). The read-only guard hook enforces exactly these.
 */
export function readOnlyBashPrefixes(permissions: AgentPermissions): string[] {
  return unique(
    permissions.allow.flatMap((rule) => {
      if (rule === "Bash") return ["*"];
      const match = /^Bash\((.+?)(?::\*)?\)$/.exec(rule);
      const prefix = match?.[1]?.trim();
      return prefix ? [prefix] : [];
    }),
  );
}

/**
 * The read-only guard hook (Claude Code `PreToolUse`). It lives outside `src`,
 * so `src/agents` and `dist/agents` both find it at the same relative place.
 */
export const GUARD_READONLY_SCRIPT = fileURLToPath(
  new URL("../../hooks/guard-readonly.mjs", import.meta.url),
);

/** The guard's allow list (a JSON array of command prefixes), inherited by the hook. */
export const GUARD_ALLOW_ENV = "BLACKWALL_GUARD_ALLOW";

/**
 * The hook command that runs the guard: both paths double-quoted with forward
 * slashes, which Git Bash (Claude Code's hook shell on Windows), cmd and POSIX
 * sh all read the same. Throws on a path it cannot quote safely.
 */
export function guardHookCommand(execPath: string, scriptPath: string): string {
  const quote = (path: string) => {
    if (/["$`]/.test(path)) throw new Error(`Cannot quote this path in a hook command: ${path}`);
    return `"${path.replace(/\\/g, "/")}"`;
  };
  return `${quote(execPath)} ${quote(scriptPath)}`;
}

/** Whether the run is a read-only Claude agent under Trusted, which the guard hook covers. */
function guarded({ cli, profile, trust }: AgentPermissions): boolean {
  return cli === "claude" && profile === "read-only" && trust.level === "trusted";
}

/** The guard's environment for a run: its allow list when the run is guarded, else nothing. */
export function guardEnv(permissions: AgentPermissions): Record<string, string> {
  if (!guarded(permissions)) return {};
  return { [GUARD_ALLOW_ENV]: JSON.stringify(readOnlyBashPrefixes(permissions)) };
}

/**
 * What a Trusted run loads from the repo, as the adapter found or prepared it.
 * Project MCP servers and hooks reach implementers only, and only when the
 * trust turns them on: {@link permissionArgs} drops them for anything else.
 */
export interface ProjectLoad {
  /** The working directory; Copilot loads its skills and agents through `--add-dir`. */
  cwd?: string;
  /** Claude: a harness plugin holding copies of the repo's skills and sub-agents. */
  pluginDir?: string;
  /** The repo's MCP config file (`.mcp.json`). */
  mcpConfig?: string;
  /** Claude: the names of the servers in it, allowed as `mcp__<name>`. */
  mcpServers?: readonly string[];
  /** Claude: the `hooks` of the repo's `.claude/settings.json`. */
  hooks?: Record<string, unknown>;
}

/**
 * Command-line flags enforcing the permissions. All three CLIs run headless, so
 * any tool call not allowed is refused rather than prompted for, and all confine
 * file access to the working directory (the task's worktree) plus `readDirs`,
 * which only read-only agents get (`--add-dir`).
 *
 * Trusted keeps Locked's flags and rules and adds what `project` names. Claude
 * stays `--restricted`, which never loads the repo's skills, agents or
 * `settings.json` by itself, and gets the harness plugin with copies of the
 * repo's skills and agents, plus the guard hook for read-only agents. Copilot
 * loads the repo's skills and agents through `--add-dir`. Project MCP servers
 * and hooks only ever reach implementers. Unrestricted is each CLI's own
 * "allow everything" mode.
 */
export function permissionArgs(permissions: AgentPermissions, project: ProjectLoad = {}): string[] {
  const { cli, profile, allow, deny, readDirs, trust } = permissions;
  const addDirs = readDirs.flatMap((dir) => ["--add-dir", dir]);
  // OpenCode has no permission flags; its rules go in through config (`opencodeConfig`).
  if (cli === "opencode") return [];
  const trusted = trust.level === "trusted";
  const implement = profile === "implement";
  const mcpConfig = trusted && implement && trust.projectMcp ? project.mcpConfig : undefined;
  if (cli === "claude") {
    if (trust.level === "unrestricted") {
      return ["--permission-mode", "bypassPermissions", ...addDirs];
    }
    const hooks = trusted && implement && trust.projectHooks ? project.hooks : undefined;
    const settings = guarded(permissions) ? guardSettings() : hooks ? { hooks } : undefined;
    const tools = unique([
      ...CLAUDE_TOOLS[profile],
      ...(trusted ? CLAUDE_TRUSTED_TOOLS[profile] : []),
    ]);
    const mcpAllow = mcpConfig ? (project.mcpServers ?? []).map((name) => `mcp__${name}`) : [];
    return [
      // Ignores user/project settings (and their allow rules), drops code-running
      // tools not named in --tools, and confines file tools to the working directory.
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      ...(trusted && project.pluginDir ? ["--plugin-dir", project.pluginDir] : []),
      ...(mcpConfig ? ["--mcp-config", mcpConfig] : []),
      // Before --tools, so the variadic --add-dir and --mcp-config always end at a flag.
      ...addDirs,
      ...(settings ? ["--settings", JSON.stringify(settings)] : []),
      "--tools",
      tools.join(","),
      "--allowedTools",
      [...allow, ...mcpAllow].join(","),
      "--disallowedTools",
      deny.join(","),
    ];
  }
  if (trust.level === "unrestricted") return ["--no-ask-user", "--allow-all", ...addDirs];
  const excluded = [
    ...COPILOT_EXCLUDED_TOOLS[profile],
    ...(trusted ? [] : COPILOT_LOCKED_EXCLUDED_TOOLS),
  ];
  return [
    "--no-ask-user",
    // The built-in GitHub MCP server can open PRs and post comments.
    "--disable-builtin-mcps",
    "--disallow-temp-dir",
    ...addDirs,
    ...(trusted && project.cwd ? ["--add-dir", project.cwd] : []),
    ...(mcpConfig ? ["--additional-mcp-config", `@${mcpConfig}`] : []),
    ...excluded.map((tool) => `--excluded-tools=${tool}`),
    ...allow.map((rule) => `--allow-tool=${rule}`),
    ...deny.map((rule) => `--deny-tool=${rule}`),
  ];
}

/** Claude Code `--settings` adding the read-only guard hook (see {@link GUARD_READONLY_SCRIPT}). */
function guardSettings() {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|NotebookEdit",
          hooks: [
            { type: "command", command: guardHookCommand(process.execPath, GUARD_READONLY_SCRIPT) },
          ],
        },
      ],
    },
  };
}

type OpencodeAction = "allow" | "deny";

/**
 * OpenCode's permission config: a top-level action per tool, and a pattern map
 * for `bash` (commands), `task` (sub-agent names) and `external_directory`
 * (folders outside the working directory).
 */
export type OpencodePermission = Record<string, OpencodeAction | Record<string, OpencodeAction>>;

/** An agent in the injected config; the repo's sub-agents are injected under Trusted. */
export interface OpencodeAgentConfig {
  mode: "primary" | "subagent";
  permission: OpencodePermission;
  description?: string;
  prompt?: string;
  model?: string;
}

/**
 * OpenCode config injected for a run (`OPENCODE_CONFIG_CONTENT`). `mcp` and
 * `plugin` stay empty except for Trusted implementers with the repo's MCP
 * servers or hooks turned on, and are left out under Unrestricted, which loads
 * every config source as OpenCode itself would.
 */
export interface OpencodeConfig {
  permission: OpencodePermission;
  agent: {
    blackwall: { mode: "primary"; permission: OpencodePermission };
    "blackwall-worker"?: ReturnType<typeof opencodeSubagent>;
  } & { [name: string]: OpencodeAgentConfig | undefined };
  mcp?: Record<string, unknown>;
  plugin?: string[];
  /** Trusted: the repo's instruction files (`AGENTS.md`, `CLAUDE.md`). */
  instructions?: string[];
  /** Trusted: the repo's skill folders, the only skills loaded. */
  skills?: { paths: string[] };
  share: "disabled";
}

/** What a Trusted OpenCode run takes from the repo (see `project-config.ts`). */
export interface OpencodeProject {
  /** Sub-agents by name, without permissions: they get the run's. */
  agents: Record<string, { description: string; prompt: string; model?: string }>;
  /** Absolute paths of the instruction files that exist. */
  instructions: string[];
  /** Absolute paths of the skill folders that exist. */
  skillPaths: string[];
  /** The repo config's `mcp` entries. */
  mcp: Record<string, unknown>;
  /** The repo config's `plugin` entries. */
  plugin: string[];
}

/** The injected primary agent's name; no repo agent may take it. */
const OPENCODE_PRIMARY = "blackwall";

interface OpencodeRule {
  tool: string;
  pattern: string | null;
}

/** OpenCode tools whose rules may take a pattern: command globs and sub-agent names. */
const OPENCODE_PATTERN_TOOLS = ["bash", "task"] as const;

/** A rule's pattern, `null` for a bare tool key; throws on a rule outside the grammar. */
function opencodeRule(rule: string): OpencodeRule {
  if (!opencodeRuleSchema.safeParse(rule).success) {
    throw new Error(`Not an OpenCode permission rule: ${rule}`);
  }
  const match = /^(bash|task)\((.+)\)$/.exec(rule);
  return match ? { tool: match[1]!, pattern: match[2]! } : { tool: rule, pattern: null };
}

/**
 * A tool's pattern map. OpenCode applies the last matching pattern, so the
 * default comes first, then the allowed patterns, then every denied one: a deny
 * always wins, even over a bare allow of the tool.
 */
function patternMap(
  tool: string,
  allowed: readonly OpencodeRule[],
  denied: readonly OpencodeRule[],
): Record<string, OpencodeAction> {
  const bareDenied = denied.some((r) => r.tool === tool && r.pattern === null);
  const map: Record<string, OpencodeAction> = {
    "*":
      !bareDenied && allowed.some((r) => r.tool === tool && r.pattern === null) ? "allow" : "deny",
  };
  for (const { tool: name, pattern } of allowed) {
    if (name === tool && pattern !== null && !bareDenied) map[pattern] = "allow";
  }
  for (const { tool: name, pattern } of denied) {
    if (name !== tool || pattern === null) continue;
    // Re-inserted so it lands after any allow of the same pattern.
    delete map[pattern];
    map[pattern] = "deny";
  }
  return map;
}

/**
 * OpenCode's `external_directory` rule: denied, unless `readDirs` lists folders
 * and no deny names the tool; then only those folders (and everything under
 * them) are allowed. OpenCode's `*` matches across `/`, and it compares
 * forward-slash paths.
 */
function externalDirectory(
  readDirs: readonly string[],
  denied: readonly OpencodeRule[],
): OpencodeAction | Record<string, OpencodeAction> {
  if (readDirs.length === 0 || denied.some((r) => r.tool === "external_directory")) return "deny";
  const map: Record<string, OpencodeAction> = { "*": "deny" };
  for (const dir of readDirs) {
    const path = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    map[path] = "allow";
    map[`${path}/*`] = "allow";
  }
  return map;
}

/**
 * OpenCode config enforcing the permissions. Everything starts denied (a
 * headless run never asks); a tool key is allowed only if an allow names it and
 * no deny does. `bash` and `task` get pattern maps (see {@link patternMap}),
 * but a bare `task` deny stays a plain deny. `external_directory` comes from
 * `readDirs` alone (see {@link externalDirectory}). The run pins the injected
 * `blackwall` agent, so the built-in agents' permissions never apply. When the
 * `task` map allows the worker, the config defines it, on `subagentModel` if
 * given and otherwise on the parent's model.
 *
 * Under Trusted, `project` adds the repo's instruction files, its skill
 * folders and its sub-agents, each bound by the run's permissions (reachable
 * through `task` only where the worker is); its MCP servers and plugins only
 * for implementers with them turned on. Under Unrestricted everything is
 * allowed and nothing else is overridden.
 */
export function opencodeConfig(
  permissions: AgentPermissions,
  {
    subagentModel,
    project,
  }: { subagentModel?: string | undefined; project?: OpencodeProject | undefined } = {},
): OpencodeConfig {
  const { cli, profile, allow, deny, readDirs, trust } = permissions;
  if (cli !== "opencode") throw new Error(`Permissions for ${cli} are not OpenCode rules`);
  if (trust.level === "unrestricted") {
    const permission: OpencodePermission = { "*": "allow" };
    return {
      permission,
      agent: {
        blackwall: { mode: "primary", permission },
        ...(profile === "implement"
          ? { [SUBAGENT_NAME]: opencodeSubagent(permission, subagentModel) }
          : {}),
      },
      share: "disabled",
    };
  }
  const trusted = trust.level === "trusted" && project !== undefined;
  const projectAgents = trusted
    ? Object.keys(project.agents).filter(
        (name) => name !== OPENCODE_PRIMARY && name !== SUBAGENT_NAME,
      )
    : [];
  const allowed = allow.map(opencodeRule);
  const denied = deny.map(opencodeRule);
  const permission: OpencodePermission = { "*": "deny" };
  for (const tool of OPENCODE_TOOLS) {
    if ((OPENCODE_PATTERN_TOOLS as readonly string[]).includes(tool)) continue;
    if (tool === "external_directory") continue;
    const allows = allowed.some((r) => r.tool === tool && r.pattern === null);
    const denies = denied.some((r) => r.tool === tool);
    if (allows || denies) permission[tool] = allows && !denies ? "allow" : "deny";
  }
  const workerTask = denied.some((r) => r.tool === "task" && r.pattern === null)
    ? "deny"
    : patternMap("task", allowed, denied);
  const workerAllowed =
    workerTask !== "deny" && (workerTask[SUBAGENT_NAME] ?? workerTask["*"]) === "allow";
  // The repo's sub-agents are reachable wherever the worker is, and bound by the same denies.
  const task =
    workerAllowed && projectAgents.length > 0
      ? patternMap(
          "task",
          [...allowed, ...projectAgents.map((name) => ({ tool: "task", pattern: name }))],
          denied,
        )
      : workerTask;
  permission.task = task;
  permission.bash = patternMap("bash", allowed, denied);
  permission.external_directory = externalDirectory(readDirs, denied);
  const agent: OpencodeConfig["agent"] = { blackwall: { mode: "primary", permission } };
  if (workerAllowed) {
    agent[SUBAGENT_NAME] = opencodeSubagent(permission, subagentModel);
  }
  if (!trusted) return { permission, agent, mcp: {}, plugin: [], share: "disabled" };
  for (const name of projectAgents) {
    const { description, prompt, model } = project.agents[name]!;
    agent[name] = {
      mode: "subagent",
      description,
      prompt,
      permission: { ...permission, task: "deny" },
      ...(model ? { model } : {}),
    };
  }
  const implement = profile === "implement";
  return {
    permission,
    agent,
    mcp: implement && trust.projectMcp ? project.mcp : {},
    plugin: implement && trust.projectHooks ? project.plugin : [],
    instructions: project.instructions,
    skills: { paths: project.skillPaths },
    share: "disabled",
  };
}
