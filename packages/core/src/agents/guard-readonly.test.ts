import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_ALLOW_ENV, GUARD_READONLY_SCRIPT, guardHookCommand } from "./permissions.js";

describe("guardHookCommand", () => {
  it("quotes a Windows path with spaces, with forward slashes", () => {
    expect(
      guardHookCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Code\\bw\\hooks\\guard.mjs"),
    ).toBe('"C:/Program Files/nodejs/node.exe" "C:/Code/bw/hooks/guard.mjs"');
  });

  it("quotes a POSIX path with a space", () => {
    expect(guardHookCommand("/usr/bin/node", "/home/me/my code/guard.mjs")).toBe(
      '"/usr/bin/node" "/home/me/my code/guard.mjs"',
    );
  });

  it("refuses a path it cannot quote", () => {
    expect(() => guardHookCommand('/usr/bin/"node', "/a.mjs")).toThrow(/quote/);
    expect(() => guardHookCommand("/usr/bin/node", "/home/$USER/a.mjs")).toThrow(/quote/);
    expect(() => guardHookCommand("/usr/bin/node", "/home/`x`/a.mjs")).toThrow(/quote/);
  });

  it("points at the script that ships with the package", () => {
    expect(existsSync(GUARD_READONLY_SCRIPT)).toBe(true);
    expect(GUARD_READONLY_SCRIPT.replace(/\\/g, "/")).toMatch(
      /packages\/core\/hooks\/guard-readonly\.mjs$/,
    );
  });
});

describe("the read-only guard hook", () => {
  let dir: string;
  let command: string;

  beforeAll(() => {
    // A folder with a space, as under "C:\Program Files" or a user's name.
    dir = join(mkdtempSync(join(tmpdir(), "blackwall-guard-")), "with space");
    mkdirSync(dir);
    const script = join(dir, "guard-readonly.mjs");
    copyFileSync(GUARD_READONLY_SCRIPT, script);
    command = guardHookCommand(process.execPath, script);
  });

  afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  /** The hook's decision for a tool call: "deny" with its reason, or "allow" (no output). */
  function run(toolName: string, toolInput: unknown, allow?: string[] | string) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env[GUARD_ALLOW_ENV];
    if (allow !== undefined) {
      env[GUARD_ALLOW_ENV] = typeof allow === "string" ? allow : JSON.stringify(allow);
    }
    // Through a shell, as Claude Code runs hook commands.
    const result = spawnSync(command, {
      shell: true,
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      }),
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    if (!result.stdout.trim()) return "allow";
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    return output.hookSpecificOutput.permissionDecision as string;
  }

  const allow = ["git diff", "git log", "git show", "git status"];

  it("lets an allowed command through", () => {
    expect(run("Bash", { command: "git diff HEAD~1 --stat" }, allow)).toBe("allow");
    expect(run("Bash", { command: "git status" }, allow)).toBe("allow");
    expect(run("Read", { file_path: "README.md" }, allow)).toBe("allow");
  });

  it("denies other commands, chained commands and prefixes without a word boundary", () => {
    expect(run("Bash", { command: "rm x" }, allow)).toBe("deny");
    expect(run("Bash", { command: "sed -i 's/a/b/' README.md" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git status; rm x" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git status && rm x" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git diff > out.txt" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git log $(rm x)" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git status\nrm x" }, allow)).toBe("deny");
    expect(run("Bash", { command: "git difftool -x rm" }, allow)).toBe("deny");
  });

  it("denies the file-writing tools", () => {
    expect(run("Edit", { file_path: "a", old_string: "a", new_string: "b" }, allow)).toBe("deny");
    expect(run("Write", { file_path: "a", content: "b" }, allow)).toBe("deny");
    expect(run("NotebookEdit", { notebook_path: "a" }, allow)).toBe("deny");
  });

  it("denies everything without a valid allow list", () => {
    expect(run("Bash", { command: "git status" })).toBe("deny");
    expect(run("Read", { file_path: "a" })).toBe("deny");
    expect(run("Bash", { command: "git status" }, "not json")).toBe("deny");
    expect(run("Bash", { command: "git status" }, '{"git status":true}')).toBe("deny");
  });

  it("allows any plain command under a bare Bash allow", () => {
    expect(run("Bash", { command: "npm test" }, ["*"])).toBe("allow");
    expect(run("Bash", { command: "npm test; rm x" }, ["*"])).toBe("deny");
  });
});
