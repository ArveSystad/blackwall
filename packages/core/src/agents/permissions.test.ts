import { describe, expect, it } from "vitest";
import { permissionArgs, permissionsFor } from "./permissions.js";

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

  it("deduplicates override rules", () => {
    const permissions = permissionsFor("copilot", "implement", { deny: ["shell(git push)"] });
    expect(permissions.deny.filter((r) => r === "shell(git push)")).toHaveLength(1);
  });
});
