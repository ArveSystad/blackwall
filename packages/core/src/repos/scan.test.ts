import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitDirKind } from "./git.js";
import { findGitRepos } from "./scan.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blackwall-scan-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A folder that looks like a git repo to the scanner (a `.git` folder). */
function fakeRepo(...segments: string[]): string {
  const path = join(root, ...segments);
  mkdirSync(join(path, ".git"), { recursive: true });
  return path;
}

function gitFile(content: string, ...segments: string[]): string {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), content);
  return path;
}

describe("gitDirKind", () => {
  it("tells repos, linked worktrees and plain folders apart", async () => {
    expect(await gitDirKind(fakeRepo("app"))).toBe("repo");
    expect(await gitDirKind(gitFile("gitdir: ../.git/modules/lib\n", "sub"))).toBe("repo");
    expect(
      await gitDirKind(
        gitFile("gitdir: C:/code/app/.git/worktrees/task-1\n", "app.worktrees", "t"),
      ),
    ).toBe("worktree");
    expect(await gitDirKind(gitFile("garbage", "odd"))).toBe("none");
    expect(await gitDirKind(root)).toBe("none");
  });
});

describe("findGitRepos", () => {
  it("finds repos within the depth limit and skips what it should", async () => {
    const expected = [fakeRepo("a"), fakeRepo("group", "b"), fakeRepo("group", "c", "d")];
    fakeRepo("a", "packages", "nested"); // inside a repo
    fakeRepo("node_modules", "dep"); // dependencies
    fakeRepo(".cache", "hidden"); // hidden folder
    fakeRepo("x", "y", "z", "too-deep"); // depth 4
    gitFile("gitdir: /code/a/.git/worktrees/t1\n", "a.worktrees", "t1");
    writeFileSync(join(root, "file.txt"), "");

    expect(await findGitRepos(root, 3)).toEqual(expected.sort());
    expect(await findGitRepos(root, 1)).toEqual([join(root, "a")]);
  });

  it("returns the root itself when it is a repo", async () => {
    mkdirSync(join(root, ".git"));
    fakeRepo("inner");
    expect(await findGitRepos(root, 3)).toEqual([root]);
    expect(await findGitRepos(join(root, "missing"), 3)).toEqual([]);
  });
});
