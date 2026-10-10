import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBranchSync } from "./git.js";

let root: string;
let repo: string;
let origin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function configure(dir: string): void {
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
}

function commit(dir: string, file: string, content: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", `edit ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-repo-git-")));
  origin = join(root, "origin.git");
  repo = join(root, "app");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  configure(repo);
  git(repo, "remote", "add", "origin", origin);
  commit(repo, "README.md", "hello\n");
  git(repo, "push", "--quiet", "origin", "main");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readBranchSync", () => {
  it("reads a synced main as nothing ahead or behind", async () => {
    expect(await readBranchSync(repo, "main")).toEqual({ branch: "main", ahead: 0, behind: 0 });
  });

  it("counts local commits origin/main doesn't have", async () => {
    commit(repo, "a.txt", "a\n");
    expect(await readBranchSync(repo, "main")).toEqual({ branch: "main", ahead: 1, behind: 0 });
  });

  it("tracks main while a feature branch is checked out", async () => {
    git(repo, "checkout", "--quiet", "-b", "feature");
    const sha = commit(repo, "b.txt", "b\n");
    git(repo, "update-ref", "refs/heads/main", sha);
    expect(await readBranchSync(repo, "main")).toEqual({ branch: "main", ahead: 1, behind: 0 });
  });

  it("reads the counts on a detached HEAD", async () => {
    commit(repo, "c.txt", "c\n");
    git(repo, "checkout", "--quiet", "--detach");
    expect(await readBranchSync(repo, "main")).toEqual({ branch: "main", ahead: 1, behind: 0 });
  });

  it("is null without origin/main", async () => {
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    expect(await readBranchSync(repo, "main")).toBeNull();
  });

  it("is null without a local branch", async () => {
    expect(await readBranchSync(repo, "trunk")).toBeNull();
  });

  it("counts fetched commits the local branch doesn't have", async () => {
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    configure(other);
    commit(other, "d.txt", "d\n");
    git(other, "push", "--quiet", "origin", "main");
    git(repo, "fetch", "--quiet", "origin");
    expect(await readBranchSync(repo, "main")).toEqual({ branch: "main", ahead: 0, behind: 1 });
  });
});
