import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySeedRepo, copySeedRepoWithOrigin, git } from "./git.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-seed-test-")));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("copySeedRepo", () => {
  it("copies a clean repo on main with one commit and the test identity", () => {
    const repo = join(root, "repo");
    copySeedRepo(repo);
    expect(git(repo, "branch", "--show-current").trim()).toBe("main");
    expect(git(repo, "log", "--format=%s").trim()).toBe("initial");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "config", "user.name").trim()).toBe("Test");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello\n");
  });

  it("commits custom files with a custom message", () => {
    const repo = join(root, "repo");
    copySeedRepo(repo, { files: { "src/a.ts": "export {};\n" }, message: "seed" });
    expect(git(repo, "log", "--format=%s").trim()).toBe("seed");
    expect(git(repo, "ls-files").trim()).toBe("src/a.ts");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("export {};\n");
  });

  it("gives every copy its own history", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    copySeedRepo(first);
    copySeedRepo(second);
    writeFileSync(join(first, "README.md"), "changed\n");
    git(first, "commit", "--quiet", "-am", "change");
    expect(git(second, "log", "--format=%s").trim()).toBe("initial");
    expect(readFileSync(join(second, "README.md"), "utf8")).toBe("hello\n");
  });
});

describe("copySeedRepoWithOrigin", () => {
  it("points origin at the copied bare repo and pushes to it", () => {
    const repo = join(root, "repo");
    const origin = join(root, "origin.git");
    copySeedRepoWithOrigin(repo, origin);
    expect(git(repo, "remote", "get-url", "origin").trim()).toBe(origin);
    expect(git(origin, "log", "--format=%s", "main").trim()).toBe("initial");

    writeFileSync(join(repo, "README.md"), "changed\n");
    git(repo, "commit", "--quiet", "-am", "change");
    git(repo, "push", "--quiet", "origin", "main");
    expect(git(origin, "log", "--format=%s", "main").trim().split("\n")).toEqual([
      "change",
      "initial",
    ]);
  });
});
