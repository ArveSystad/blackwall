import { describe, expect, it } from "vitest";
import { REMOTE_COMMANDS, opencodeConfig, permissionArgs, permissionsFor } from "./permissions.js";

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
    expect(
      flagValues(permissionArgs(permissionsFor("copilot", "implement")), "--excluded-tools"),
    ).toEqual([]);
    expect(
      flagValues(permissionArgs(permissionsFor("copilot", "read-only")), "--excluded-tools"),
    ).toEqual(["task"]);
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
      "bash(git diff*)",
      "bash(git log*)",
      "bash(git show*)",
      "bash(git status*)",
    ]);
    expect(deny).toEqual(
      expect.arrayContaining(["edit", "task", "webfetch", "external_directory", "bash(git push*)"]),
    );
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
    expect(bash["git status*"]).toBe("allow");
    expect(keys.indexOf("git push*")).toBeGreaterThan(keys.indexOf("git status*"));
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
      Object.keys(bash).indexOf("git status*"),
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
