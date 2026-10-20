import { LOCKED_TRUST, type AgentTrust } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  GUARD_ALLOW_ENV,
  GUARD_READONLY_SCRIPT,
  REMOTE_COMMANDS,
  guardEnv,
  guardHookCommand,
  opencodeConfig,
  permissionArgs,
  permissionsFor,
  type AgentPermissions,
  type HarnessMcp,
  type OpencodeProject,
  type ProjectLoad,
} from "./permissions.js";

/** A command's action under a bash map, mirroring OpenCode's last-match glob rule. */
function bashAction(bash: Record<string, string>, command: string): string | undefined {
  const matches = (pattern: string) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      "s",
    ).test(command);
  return Object.entries(bash).findLast(([pattern]) => matches(pattern))?.[1];
}

/** Values passed to a repeated `--flag=value` option. */
function flagValues(args: string[], flag: string): string[] {
  return args.filter((a) => a.startsWith(`${flag}=`)).map((a) => a.slice(flag.length + 1));
}

/** Comma-joined value after a `--flag value` option. */
function listAfter(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  return index === -1 ? [] : (args[index + 1] ?? "").split(",");
}

describe("Claude Code permissions", () => {
  it("gives reviewers read tools and safe git only", () => {
    const args = permissionArgs(permissionsFor("claude", "read-only"));
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(
      args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ).toEqual(["--permission-mode", "dontAsk"]);
    expect(listAfter(args, "--tools")).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(listAfter(args, "--allowedTools")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git status:*)",
    ]);
    const deny = listAfter(args, "--disallowedTools");
    expect(deny).toEqual(expect.arrayContaining(["Edit", "Write", "Bash(git push:*)"]));
  });

  it("lets implementers edit and run commands but never push or use gh", () => {
    const args = permissionArgs(permissionsFor("claude", "implement"));
    expect(listAfter(args, "--tools")).toEqual(expect.arrayContaining(["Edit", "Write", "Bash"]));
    expect(listAfter(args, "--allowedTools")).toEqual(
      expect.arrayContaining(["Edit", "Write", "Bash"]),
    );
    expect(listAfter(args, "--disallowedTools")).toEqual(
      expect.arrayContaining([
        "Bash(git push:*)",
        "Bash(git remote:*)",
        "Bash(git fetch:*)",
        "Bash(git -C:*)",
        "Bash(gh:*)",
      ]),
    );
  });

  it("lets implementers start only the harness-defined sub-agent", () => {
    const args = permissionArgs(permissionsFor("claude", "implement"));
    expect(listAfter(args, "--tools")).toContain("Agent");
    const allow = listAfter(args, "--allowedTools");
    expect(allow).toContain("Agent(blackwall-worker)");
    expect(allow).not.toContain("Agent");
    expect(listAfter(args, "--disallowedTools")).toEqual(
      expect.arrayContaining(["Agent(general-purpose)", "Agent(Explore)", "Agent(Plan)"]),
    );
    expect(listAfter(args, "--disallowedTools")).not.toContain("Agent(blackwall-worker)");
  });

  it("gives reviewers no sub-agents", () => {
    const permissions = permissionsFor("claude", "read-only");
    const args = permissionArgs(permissions);
    expect(listAfter(args, "--tools")).not.toContain("Agent");
    expect(permissions.allow.some((rule) => rule.startsWith("Agent"))).toBe(false);
  });

  it("adds an agent's overrides without lifting a deny or adding edit tools", () => {
    const permissions = permissionsFor("claude", "read-only", {
      allow: ["Bash(npm test:*)", "Edit"],
      deny: ["Bash(git log:*)"],
    });
    expect(permissions.allow).toContain("Bash(npm test:*)");
    expect(permissions.deny).toEqual(expect.arrayContaining(["Edit", "Bash(git log:*)"]));
    expect(listAfter(permissionArgs(permissions), "--tools")).not.toContain("Edit");
  });
});

describe("Copilot CLI permissions", () => {
  it("denies writes for reviewers and allows only safe git in the shell", () => {
    const args = permissionArgs(permissionsFor("copilot", "read-only"));
    expect(args).toEqual(
      expect.arrayContaining(["--no-ask-user", "--disable-builtin-mcps", "--disallow-temp-dir"]),
    );
    expect(args.some((a) => a.startsWith("--allow-all"))).toBe(false);
    expect(flagValues(args, "--allow-tool")).toEqual([
      "shell(git diff)",
      "shell(git log)",
      "shell(git show)",
      "shell(git status)",
    ]);
    expect(flagValues(args, "--deny-tool")).toEqual(
      expect.arrayContaining(["write", "shell(git push)"]),
    );
  });

  it("lets implementers write and use the shell but never push or use gh", () => {
    const args = permissionArgs(permissionsFor("copilot", "implement"));
    expect(flagValues(args, "--allow-tool")).toEqual(["write", "shell"]);
    expect(flagValues(args, "--deny-tool")).toEqual(
      expect.arrayContaining([
        "shell(git push)",
        "shell(git remote)",
        "shell(git pull)",
        "shell(gh)",
        "shell(gh:*)",
      ]),
    );
    expect(flagValues(args, "--deny-tool")).not.toContain("write");
  });

  it("keeps the task tool for implementers and removes it for reviewers", () => {
    // Copilot runs `task` without asking; only removing the tool stops sub-agents.
    // Locked also removes `skill`: Copilot loads the repo's skills in a folder the user trusts.
    expect(
      flagValues(permissionArgs(permissionsFor("copilot", "implement")), "--excluded-tools"),
    ).toEqual(["skill"]);
    expect(
      flagValues(permissionArgs(permissionsFor("copilot", "read-only")), "--excluded-tools"),
    ).toEqual(["task", "skill"]);
  });

  it("deduplicates override rules", () => {
    const permissions = permissionsFor("copilot", "implement", { deny: ["shell(git push)"] });
    expect(permissions.deny.filter((r) => r === "shell(git push)")).toHaveLength(1);
  });
});

describe("OpenCode permissions", () => {
  it("gives reviewers read tools and safe git only", () => {
    const { allow, deny } = permissionsFor("opencode", "read-only");
    expect(allow).toEqual([
      "read",
      "grep",
      "glob",
      "list",
      "bash(git diff)",
      "bash(git diff *)",
      "bash(git log)",
      "bash(git log *)",
      "bash(git show)",
      "bash(git show *)",
      "bash(git status)",
      "bash(git status *)",
    ]);
    expect(deny).toEqual(
      expect.arrayContaining(["edit", "task", "webfetch", "skill", "bash(git push*)"]),
    );
    expect(opencodeConfig(permissionsFor("opencode", "read-only")).permission).toMatchObject({
      external_directory: "deny",
    });
  });

  it("lets implementers edit, use bash and start only the worker, but never push or use gh", () => {
    const { allow, deny } = permissionsFor("opencode", "implement");
    expect(allow).toEqual(
      expect.arrayContaining(["edit", "bash(*)", "todowrite", "task(blackwall-worker)"]),
    );
    expect(deny).toEqual(
      expect.arrayContaining([
        "task(general)",
        "task(explore)",
        "bash(git push*)",
        "bash(git -C*)",
        "bash(gh*)",
      ]),
    );
    expect(deny).not.toContain("edit");
    expect(deny).not.toContain("task");
  });

  it("gives reviewers no sub-agents", () => {
    const config = opencodeConfig(permissionsFor("opencode", "read-only"));
    expect(config.permission.task).toBe("deny");
    expect(config.agent["blackwall-worker"]).toBeUndefined();
  });

  it("defines the worker for implementers, bound by the run's denies", () => {
    const config = opencodeConfig(permissionsFor("opencode", "implement"));
    const task = config.permission.task as Record<string, string>;
    expect(Object.entries(task)).toEqual([
      ["*", "deny"],
      ["blackwall-worker", "allow"],
      ["general", "deny"],
      ["explore", "deny"],
    ]);
    const worker = config.agent["blackwall-worker"];
    expect(worker).toMatchObject({ mode: "subagent" });
    expect(worker).not.toHaveProperty("model");
    expect(worker?.prompt).toContain("Do not commit, push, fetch");
    expect(worker?.permission.task).toBe("deny");
    expect(worker?.permission.bash).toEqual(config.permission.bash);
    expect(worker?.permission.bash).toMatchObject({ "git push*": "deny", "gh*": "deny" });
  });

  it("runs the worker on the given sub-agent model", () => {
    const config = opencodeConfig(permissionsFor("opencode", "implement"), {
      subagentModel: "anthropic/claude-haiku-5-5",
    });
    expect(config.agent["blackwall-worker"]?.model).toBe("anthropic/claude-haiku-5-5");
  });

  it("never opens the built-in sub-agents, even to a bare task allow", () => {
    const task = opencodeConfig(permissionsFor("opencode", "implement", { allow: ["task"] }))
      .permission.task as Record<string, string>;
    expect(task).toMatchObject({ "*": "allow", general: "deny", explore: "deny" });
    expect(Object.keys(task).slice(-2)).toEqual(["general", "explore"]);
  });

  it("drops the worker when a deny override names it", () => {
    const config = opencodeConfig(
      permissionsFor("opencode", "implement", { deny: ["task(blackwall-worker)"] }),
    );
    expect((config.permission.task as Record<string, string>)["blackwall-worker"]).toBe("deny");
    expect(config.agent["blackwall-worker"]).toBeUndefined();
  });

  it("has no flags: the rules go in through config", () => {
    expect(permissionArgs(permissionsFor("opencode", "implement"))).toEqual([]);
  });

  it("denies everything by default and puts deny patterns after allow patterns", () => {
    const config = opencodeConfig(permissionsFor("opencode", "read-only"));
    const { permission } = config;
    expect(Object.keys(permission)[0]).toBe("*");
    expect(permission).toMatchObject({
      "*": "deny",
      read: "allow",
      grep: "allow",
      edit: "deny",
      task: "deny",
      external_directory: "deny",
    });
    const bash = permission.bash as Record<string, string>;
    const keys = Object.keys(bash);
    expect(keys[0]).toBe("*");
    expect(bash["*"]).toBe("deny");
    expect(bash["git status"]).toBe("allow");
    expect(bash["git status *"]).toBe("allow");
    expect(keys.indexOf("git push*")).toBeGreaterThan(keys.indexOf("git status *"));
    expect(Object.entries(bash).slice(-REMOTE_COMMANDS.length)).toEqual(
      REMOTE_COMMANDS.map((c) => [`${c}*`, "deny"]),
    );
    expect(config.agent.blackwall).toEqual({ mode: "primary", permission });
    expect(config).toMatchObject({ mcp: {}, plugin: [], share: "disabled" });
  });

  it("widens allow with overrides but never lifts a deny", () => {
    const readOnly = opencodeConfig(
      permissionsFor("opencode", "read-only", { allow: ["edit", "bash(npm test*)", "webfetch"] }),
    ).permission;
    expect(readOnly.edit).toBe("deny");
    expect(readOnly.webfetch).toBe("deny");
    expect((readOnly.bash as Record<string, string>)["npm test*"]).toBe("allow");

    const bash = opencodeConfig(permissionsFor("opencode", "implement", { allow: ["bash"] }))
      .permission.bash as Record<string, string>;
    expect(bash["*"]).toBe("allow");
    expect(Object.entries(bash).at(-1)).toEqual(["gh*", "deny"]);
    expect(Object.keys(bash).indexOf("git push*")).toBeGreaterThan(0);
    expect(bash["git push*"]).toBe("deny");
  });

  it("lets a deny override replace an allowed pattern", () => {
    const bash = opencodeConfig(
      permissionsFor("opencode", "read-only", { deny: ["bash(git log*)"] }),
    ).permission.bash as Record<string, string>;
    expect(bash["git log*"]).toBe("deny");
    expect(Object.keys(bash).indexOf("git log*")).toBeGreaterThan(
      Object.keys(bash).indexOf("git status *"),
    );
    expect(bashAction(bash, "git log -1")).toBe("deny");
    expect(bashAction(bash, "git log")).toBe("deny");
  });

  it("allows only whole safe git subcommands to reviewers", () => {
    const bash = opencodeConfig(permissionsFor("opencode", "read-only")).permission.bash as Record<
      string,
      string
    >;
    for (const command of [
      "git diff",
      "git diff --stat",
      "git log -1 --format=%s",
      "git status",
      "git show HEAD",
    ]) {
      expect(bashAction(bash, command), command).toBe("allow");
    }
    for (const command of [
      'git difftool -y -x "touch pwned.txt"',
      "git diff-tree HEAD",
      "git logx",
      "git status-foo",
      "git push origin HEAD",
      "gh pr list",
    ]) {
      expect(bashAction(bash, command), command).toBe("deny");
    }
    // No allow pattern matches difftool: its deny comes from the `*` default.
    expect(bashAction({ ...bash, "*": "default" }, 'git difftool -y -x "touch pwned.txt"')).toBe(
      "default",
    );
  });

  it("denies all of bash when bare bash is denied", () => {
    const bash = opencodeConfig(permissionsFor("opencode", "implement", { deny: ["bash"] }))
      .permission.bash as Record<string, string>;
    expect(Object.values(bash).every((action) => action === "deny")).toBe(true);
  });

  it("throws on a rule outside the grammar", () => {
    expect(() =>
      opencodeConfig(permissionsFor("opencode", "implement", { allow: ["Bash(npm test:*)"] })),
    ).toThrow(/Bash\(npm test:\*\)/);
    expect(() => opencodeConfig(permissionsFor("claude", "implement"))).toThrow(/claude/);
  });
});

describe("Reference repos", () => {
  const dirs = ["C:\\Code\\other", "/home/me/lib"];

  it("adds one --add-dir per dir for read-only Claude, before --tools", () => {
    const args = permissionArgs(permissionsFor("claude", "read-only", {}, dirs));
    const first = args.indexOf("--add-dir");
    expect(args.slice(first, first + 4)).toEqual([
      "--add-dir",
      "C:\\Code\\other",
      "--add-dir",
      "/home/me/lib",
    ]);
    expect(args[first + 4]).toBe("--tools");
    expect(args).toContain("--restricted");
  });

  it("adds one --add-dir per dir for read-only Copilot", () => {
    const args = permissionArgs(permissionsFor("copilot", "read-only", {}, dirs));
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(2);
    expect(args[args.indexOf("--add-dir") + 1]).toBe("C:\\Code\\other");
    expect(args).toContain("--disallow-temp-dir");
  });

  it("adds no --add-dir without dirs", () => {
    for (const cli of ["claude", "copilot"] as const) {
      expect(permissionArgs(permissionsFor(cli, "read-only"))).not.toContain("--add-dir");
    }
  });

  it("never gives implementers the dirs", () => {
    for (const cli of ["claude", "copilot", "opencode"] as const) {
      const permissions = permissionsFor(cli, "implement", {}, dirs);
      expect(permissions.readDirs).toEqual([]);
      expect(permissionArgs(permissions)).not.toContain("--add-dir");
    }
    expect(
      opencodeConfig(permissionsFor("opencode", "implement", {}, dirs)).permission
        .external_directory,
    ).toBe("deny");
  });

  it("allows only the dirs for read-only OpenCode, with forward slashes", () => {
    const { permission } = opencodeConfig(permissionsFor("opencode", "read-only", {}, dirs));
    expect(permission.external_directory).toEqual({
      "*": "deny",
      "C:/Code/other": "allow",
      "C:/Code/other/*": "allow",
      "/home/me/lib": "allow",
      "/home/me/lib/*": "allow",
    });
    expect(permission.edit).toBe("deny");
  });

  it("keeps OpenCode's other dirs denied without dirs or under a deny override", () => {
    expect(
      opencodeConfig(permissionsFor("opencode", "read-only")).permission.external_directory,
    ).toBe("deny");
    expect(
      opencodeConfig(
        permissionsFor("opencode", "read-only", { deny: ["external_directory"] }, dirs),
      ).permission.external_directory,
    ).toBe("deny");
  });
});

describe("Trust levels", () => {
  const trust = (
    level: AgentTrust["level"],
    extras: Partial<Pick<AgentTrust, "projectMcp" | "projectHooks">> = {},
  ): AgentTrust => ({
    level,
    projectMcp: extras.projectMcp ?? false,
    projectHooks: extras.projectHooks ?? false,
    forced: false,
    forcedReason: null,
  });
  const allOn = trust("trusted", { projectMcp: true, projectHooks: true });
  const project: ProjectLoad = {
    cwd: "C:\\work",
    pluginDir: "C:\\tmp\\plugin",
    mcpConfig: "C:\\work\\.mcp.json",
    mcpServers: ["db"],
    hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] },
  };
  const remoteDenies = (cli: "claude" | "copilot") =>
    cli === "claude"
      ? REMOTE_COMMANDS.map((c) => `Bash(${c}:*)`)
      : REMOTE_COMMANDS.map((c) => `shell(${c})`);
  const denyOf = (cli: "claude" | "copilot", args: string[]) =>
    cli === "claude" ? listAfter(args, "--disallowedTools") : flagValues(args, "--deny-tool");
  const pairAfter = (args: string[], flag: string) =>
    args.slice(args.indexOf(flag), args.indexOf(flag) + 2);

  it("keeps Locked's flags exactly as they were, whatever the repo offers", () => {
    expect(permissionArgs(permissionsFor("claude", "read-only"))).toEqual([
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--allowedTools",
      "Read,Grep,Glob,Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git status:*)",
      "--disallowedTools",
      ["Edit", "Write", "NotebookEdit", ...REMOTE_COMMANDS.map((c) => `Bash(${c}:*)`)].join(","),
    ]);
    for (const cli of ["claude", "copilot"] as const) {
      for (const profile of ["read-only", "implement"] as const) {
        const locked = permissionsFor(cli, profile, {}, [], LOCKED_TRUST);
        expect(locked).toEqual(permissionsFor(cli, profile));
        expect(permissionArgs(locked, project)).toEqual(permissionArgs(locked));
        expect(guardEnv(locked)).toEqual({});
      }
    }
    expect(opencodeConfig(permissionsFor("opencode", "implement"))).not.toHaveProperty("skills");
    expect(permissionsFor("opencode", "read-only").deny).toContain("skill");
  });

  for (const cli of ["claude", "copilot"] as const) {
    for (const profile of ["read-only", "implement"] as const) {
      it(`${cli} ${profile}: Trusted keeps every remote deny`, () => {
        const args = permissionArgs(permissionsFor(cli, profile, {}, [], allOn), project);
        expect(denyOf(cli, args)).toEqual(expect.arrayContaining(remoteDenies(cli)));
      });
    }

    it(`${cli}: read-only Trusted never gets MCP servers, project hooks or project settings`, () => {
      const args = permissionArgs(permissionsFor(cli, "read-only", {}, [], allOn), project);
      expect(args).not.toContain("--setting-sources");
      expect(args).not.toContain("--mcp-config");
      expect(args).not.toContain("--additional-mcp-config");
      expect(args.join(" ")).not.toContain("lint");
      expect(args.join(" ")).not.toContain("mcp__");
      expect(denyOf(cli, args)).toEqual(
        expect.arrayContaining(cli === "claude" ? ["Edit", "Write", "NotebookEdit"] : ["write"]),
      );
    });

    it(`${cli}: Unrestricted has no rules`, () => {
      const permissions = permissionsFor(
        cli,
        "implement",
        { deny: ["x"] },
        [],
        trust("unrestricted"),
      );
      expect(permissions.allow).toEqual([]);
      expect(permissions.deny).toEqual([]);
      const args = permissionArgs(permissions, project);
      expect(args.some((a) => /disallowed|deny-tool|excluded-tools|restricted/.test(a))).toBe(
        false,
      );
    });
  }

  it("claude: Trusted loads the repo's skills and agents through the plugin, still restricted", () => {
    const readOnly = permissionArgs(permissionsFor("claude", "read-only", {}, [], allOn), project);
    expect(readOnly).toContain("--restricted");
    expect(pairAfter(readOnly, "--plugin-dir")).toEqual(["--plugin-dir", "C:\\tmp\\plugin"]);
    expect(listAfter(readOnly, "--tools")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Skill",
      "Agent",
    ]);
    expect(listAfter(readOnly, "--allowedTools")).toContain("Skill");
    expect(listAfter(readOnly, "--disallowedTools")).toEqual(
      expect.arrayContaining(["Agent(general-purpose)", "Agent(Explore)"]),
    );
    const implement = permissionArgs(
      permissionsFor("claude", "implement", {}, [], trust("trusted")),
      project,
    );
    expect(listAfter(implement, "--tools")).toContain("Skill");
    expect(implement).toContain("--restricted");
    expect(implement).toContain("--strict-mcp-config");
    expect(implement).not.toContain("--mcp-config");
    expect(implement).not.toContain("--settings");
  });

  it("claude: read-only Trusted always carries the guard hook", () => {
    const permissions = permissionsFor(
      "claude",
      "read-only",
      { allow: ["Bash(npm test:*)"] },
      [],
      allOn,
    );
    const args = permissionArgs(permissions);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Bash|Edit|Write|NotebookEdit");
    expect(hook.hooks[0].command).toBe(guardHookCommand(process.execPath, GUARD_READONLY_SCRIPT));
    expect(hook.hooks[0].command).toContain(`"${GUARD_READONLY_SCRIPT.replace(/\\/g, "/")}"`);
    expect(JSON.parse(guardEnv(permissions)[GUARD_ALLOW_ENV]!)).toEqual([
      "git diff",
      "git log",
      "git show",
      "git status",
      "npm test",
    ]);
    expect(guardEnv(permissionsFor("claude", "implement", {}, [], allOn))).toEqual({});
  });

  it("claude: Trusted implementers get the repo's MCP servers and hooks only when turned on", () => {
    const on = permissionArgs(permissionsFor("claude", "implement", {}, [], allOn), project);
    expect(pairAfter(on, "--mcp-config")).toEqual(["--mcp-config", "C:\\work\\.mcp.json"]);
    expect(on).toContain("--strict-mcp-config");
    expect(listAfter(on, "--allowedTools")).toContain("mcp__db");
    expect(JSON.parse(on[on.indexOf("--settings") + 1]!)).toEqual({ hooks: project.hooks });
    const off = permissionArgs(
      permissionsFor("claude", "implement", {}, [], trust("trusted")),
      project,
    );
    expect(off).not.toContain("--mcp-config");
    expect(off).not.toContain("--settings");
  });

  it("claude: Unrestricted bypasses permissions and keeps the reference repos", () => {
    const args = permissionArgs(
      permissionsFor("claude", "read-only", {}, ["C:\\ref"], trust("unrestricted")),
      project,
    );
    expect(args).toEqual(["--permission-mode", "bypassPermissions", "--add-dir", "C:\\ref"]);
  });

  it("copilot: Trusted keeps the skill tool and loads the repo through --add-dir", () => {
    const readOnly = permissionArgs(permissionsFor("copilot", "read-only", {}, [], allOn), project);
    expect(flagValues(readOnly, "--excluded-tools")).toEqual(["task"]);
    expect(pairAfter(readOnly, "--add-dir")).toEqual(["--add-dir", "C:\\work"]);
    expect(readOnly).toContain("--disable-builtin-mcps");
    const implement = permissionArgs(
      permissionsFor("copilot", "implement", {}, [], allOn),
      project,
    );
    expect(flagValues(implement, "--excluded-tools")).toEqual([]);
    expect(pairAfter(implement, "--additional-mcp-config")).toEqual([
      "--additional-mcp-config",
      "@C:\\work\\.mcp.json",
    ]);
    expect(
      permissionArgs(permissionsFor("copilot", "implement", {}, [], trust("trusted")), project),
    ).not.toContain("--additional-mcp-config");
  });

  it("copilot: Unrestricted allows all", () => {
    expect(
      permissionArgs(
        permissionsFor("copilot", "implement", {}, [], trust("unrestricted")),
        project,
      ),
    ).toEqual(["--no-ask-user", "--allow-all"]);
  });

  const repoPieces: OpencodeProject = {
    agents: {
      docs: { description: "Docs writer", prompt: "Write docs." },
      blackwall: { description: "Impostor", prompt: "x" },
    },
    instructions: ["C:/work/AGENTS.md"],
    skillPaths: ["C:/work/.claude/skills"],
    mcp: { db: { type: "local", command: ["db"] } },
    plugin: ["lint-plugin"],
  };

  it("opencode: Trusted allows skills and injects the repo's pieces, MCP and plugins for implementers only", () => {
    const readOnly = opencodeConfig(permissionsFor("opencode", "read-only", {}, [], allOn), {
      project: repoPieces,
    });
    expect(readOnly.permission.skill).toBe("allow");
    expect(readOnly.permission.edit).toBe("deny");
    expect(readOnly.permission.task).toBe("deny");
    expect(readOnly).toMatchObject({
      mcp: {},
      plugin: [],
      instructions: ["C:/work/AGENTS.md"],
      skills: { paths: ["C:/work/.claude/skills"] },
    });
    expect(readOnly.agent.docs).toMatchObject({ mode: "subagent", prompt: "Write docs." });
    expect(readOnly.agent.docs?.permission.bash).toEqual(readOnly.permission.bash);
    expect(readOnly.agent.blackwall).toEqual({ mode: "primary", permission: readOnly.permission });

    const implement = opencodeConfig(permissionsFor("opencode", "implement", {}, [], allOn), {
      project: repoPieces,
    });
    expect(implement).toMatchObject({ mcp: repoPieces.mcp, plugin: ["lint-plugin"] });
    const task = implement.permission.task as Record<string, string>;
    expect(task).toMatchObject({
      "*": "deny",
      "blackwall-worker": "allow",
      docs: "allow",
      general: "deny",
    });
    expect((implement.permission.bash as Record<string, string>)["git push*"]).toBe("deny");
    expect(implement.agent.docs?.permission.task).toBe("deny");

    const off = opencodeConfig(permissionsFor("opencode", "implement", {}, [], trust("trusted")), {
      project: repoPieces,
    });
    expect(off).toMatchObject({ mcp: {}, plugin: [] });
  });

  it("opencode: Unrestricted allows everything and overrides no config source", () => {
    const config = opencodeConfig(
      permissionsFor("opencode", "implement", {}, [], trust("unrestricted")),
    );
    expect(config.permission).toEqual({ "*": "allow" });
    expect(config.agent.blackwall).toEqual({ mode: "primary", permission: { "*": "allow" } });
    expect(config.agent["blackwall-worker"]).toMatchObject({ mode: "subagent" });
    expect(config).not.toHaveProperty("mcp");
    expect(config).not.toHaveProperty("plugin");
  });
});

describe("Harness MCP server", () => {
  const harnessMcp: HarnessMcp = {
    name: "blackwall",
    url: "http://127.0.0.1:4711/mcp",
    headers: { Authorization: "Bearer tok" },
    tools: ["create_task", "submit_task_draft"],
  };
  const withHarness = (permissions: AgentPermissions): AgentPermissions => ({
    ...permissions,
    harnessMcp,
  });
  const trusted: AgentTrust = {
    level: "trusted",
    projectMcp: true,
    projectHooks: false,
    forced: false,
    forcedReason: null,
  };
  const unrestricted: AgentTrust = { ...trusted, level: "unrestricted" };
  const project: ProjectLoad = { mcpConfig: "C:\\work\\.mcp.json", mcpServers: ["db"] };
  const valuesAfter = (args: string[], flag: string) => {
    const start = args.indexOf(flag) + 1;
    const end = args.findIndex((a, i) => i >= start && a.startsWith("--"));
    return args.slice(start, end === -1 ? undefined : end);
  };

  it("claude: adds the server as inline JSON and allows its tools, only when set", () => {
    const locked = permissionsFor("claude", "read-only");
    expect(permissionArgs(locked).join(" ")).not.toContain("blackwall");
    const args = permissionArgs(withHarness(locked));
    expect(args).toContain("--strict-mcp-config");
    const [config, ...rest] = valuesAfter(args, "--mcp-config");
    expect(rest).toEqual([]);
    expect(JSON.parse(config!)).toEqual({
      mcpServers: {
        blackwall: {
          type: "http",
          url: "http://127.0.0.1:4711/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
    expect(args.indexOf("--mcp-config")).toBeLessThan(args.indexOf("--tools"));
    expect(listAfter(args, "--allowedTools")).toEqual(
      expect.arrayContaining([
        "Read",
        "mcp__blackwall__create_task",
        "mcp__blackwall__submit_task_draft",
      ]),
    );
  });

  it("claude: sits next to a Trusted implementer's project MCP config", () => {
    const args = permissionArgs(
      withHarness(permissionsFor("claude", "implement", {}, [], trusted)),
      project,
    );
    const configs = valuesAfter(args, "--mcp-config");
    expect(configs[0]).toBe("C:\\work\\.mcp.json");
    expect(JSON.parse(configs[1]!).mcpServers.blackwall.type).toBe("http");
    expect(listAfter(args, "--allowedTools")).toEqual(
      expect.arrayContaining(["mcp__db", "mcp__blackwall__create_task"]),
    );
    const unrestrictedArgs = permissionArgs(
      withHarness(permissionsFor("claude", "read-only", {}, [], unrestricted)),
    );
    expect(unrestrictedArgs.slice(0, 3)).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
    ]);
  });

  it("copilot: adds the server as inline JSON and allows its tools, only when set", () => {
    const locked = permissionsFor("copilot", "read-only");
    expect(permissionArgs(locked)).not.toContain("--additional-mcp-config");
    const args = permissionArgs(withHarness(locked));
    const config = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]!);
    expect(config.mcpServers.blackwall).toEqual({
      type: "http",
      url: "http://127.0.0.1:4711/mcp",
      headers: { Authorization: "Bearer tok" },
      tools: ["create_task", "submit_task_draft"],
    });
    expect(flagValues(args, "--allow-tool")).toEqual(
      expect.arrayContaining(["blackwall(create_task)", "blackwall(submit_task_draft)"]),
    );
    const implement = permissionArgs(
      withHarness(permissionsFor("copilot", "implement", {}, [], trusted)),
      project,
    );
    expect(implement.filter((a) => a === "--additional-mcp-config")).toHaveLength(2);
    expect(implement).toContain("@C:\\work\\.mcp.json");
  });

  it("opencode: adds a remote server and allows its tools, only when set", () => {
    const locked = permissionsFor("opencode", "read-only");
    expect(opencodeConfig(locked).mcp).toEqual({});
    const config = opencodeConfig(withHarness(locked));
    expect(config.mcp).toEqual({
      blackwall: {
        type: "remote",
        url: "http://127.0.0.1:4711/mcp",
        headers: { Authorization: "Bearer tok" },
        enabled: true,
      },
    });
    expect(config.permission).toMatchObject({
      "*": "deny",
      blackwall_create_task: "allow",
      blackwall_submit_task_draft: "allow",
    });
    const implement = opencodeConfig(
      withHarness(permissionsFor("opencode", "implement", {}, [], trusted)),
      {
        project: {
          agents: {},
          instructions: [],
          skillPaths: [],
          mcp: { db: { type: "local", command: ["db"] } },
          plugin: [],
        },
      },
    );
    expect(Object.keys(implement.mcp ?? {})).toEqual(["db", "blackwall"]);
  });
});
