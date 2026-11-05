import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySeedRepo } from "../testing/index.js";
import { createGitService } from "../git/service.js";
import { createWorktreeSetup, type WorktreeSetup } from "./setup.js";

let root: string;
let repo: string;
let setup: WorktreeSetup;
const COMMANDS = ["pnpm install --frozen-lockfile"];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function write(file: string, content: string, at = repo): void {
  writeFileSync(join(at, file), content);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-setup-")));
  repo = join(root, "app");
  copySeedRepo(repo, {
    files: {
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "src/App/App.csproj": "<Project />\n",
      "README.md": "hello\n",
    },
  });
  setup = createWorktreeSetup({ git: createGitService() });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("setup key", () => {
  it("is stable across calls", async () => {
    expect(await setup.key(repo, COMMANDS)).toBe(await setup.key(repo, COMMANDS));
  });

  it("changes with a lockfile, a nested project, a new lockfile or the commands", async () => {
    const keys = [await setup.key(repo, COMMANDS)];
    write("pnpm-lock.yaml", "lockfileVersion: 9\nchanged: true\n");
    keys.push(await setup.key(repo, COMMANDS));
    write("src/App/App.csproj", "<Project Sdk='x' />\n");
    keys.push(await setup.key(repo, COMMANDS));
    write("go.sum", "sum\n");
    keys.push(await setup.key(repo, COMMANDS));
    keys.push(await setup.key(repo, ["npm ci"]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores other files", async () => {
    const before = await setup.key(repo, COMMANDS);
    write("README.md", "changed\n");
    write("notes.txt", "new\n");
    expect(await setup.key(repo, COMMANDS)).toBe(before);
  });
});

describe("setup stamp", () => {
  it("reads null without a stamp and round-trips one", async () => {
    expect(await setup.readStamp(repo)).toBeNull();
    await setup.writeStamp(repo, "abc");
    expect(await setup.readStamp(repo)).toBe("abc");
  });

  it("lives outside a linked worktree's diff", async () => {
    const worktree = join(root, "app.worktrees", "t1");
    git(repo, "worktree", "add", "--quiet", "-b", "agent/t1", worktree);
    await setup.writeStamp(worktree, "key-1");

    expect(await setup.readStamp(worktree)).toBe("key-1");
    expect(await setup.readStamp(repo)).toBeNull();
    expect(git(worktree, "status", "--porcelain")).toBe("");
  });
});
