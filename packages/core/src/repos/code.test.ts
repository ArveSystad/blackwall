import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CODE_FILE_BYTES } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySeedRepo } from "../testing/index.js";
import { isSafeCodePath, parseStatus, readRepoFile, readRepoTree } from "./code.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-code-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** A repo on `main` with the given files committed and nothing changed since. */
function committedRepo(files: Record<string, string>): string {
  const path = join(root, "app");
  copySeedRepo(path, { files });
  return path;
}

describe("readRepoTree", () => {
  it("lists tracked and untracked files, omits ignored ones and reports each change kind", async () => {
    const path = committedRepo({
      ".gitignore": ".env\n",
      "a.txt": "a\n",
      "b.txt": "b\n",
      "c.txt": "c\n",
      "d.txt": "d\n",
    });
    writeFileSync(join(path, "a.txt"), "a changed\n");
    writeFileSync(join(path, "n.txt"), "n\n");
    git(path, "add", "n.txt");
    rmSync(join(path, "c.txt"));
    git(path, "mv", "d.txt", "r.txt");
    writeFileSync(join(path, "u.txt"), "u\n");
    writeFileSync(join(path, ".env"), "SECRET=1\n");

    expect(await readRepoTree(path)).toEqual({
      branch: "main",
      files: [
        { path: ".gitignore", change: null },
        { path: "a.txt", change: "modified" },
        { path: "b.txt", change: null },
        { path: "c.txt", change: "deleted" },
        { path: "n.txt", change: "added" },
        { path: "r.txt", change: "renamed" },
        { path: "u.txt", change: "untracked" },
      ],
    });
  });

  it("names the checked-out branch", async () => {
    const path = committedRepo({ "a.txt": "a\n" });
    git(path, "switch", "-c", "feature/x");
    expect((await readRepoTree(path)).branch).toBe("feature/x");
  });
});

describe("readRepoFile", () => {
  it("returns an unchanged text file with no diff", async () => {
    const path = committedRepo({ "b.txt": "b\n" });
    expect(await readRepoFile(path, "b.txt")).toEqual({
      path: "b.txt",
      change: null,
      kind: "text",
      size: 2,
      content: "b\n",
      diff: null,
    });
  });

  it("returns a changed tracked file with every line of it as diff context", async () => {
    const path = committedRepo({ "f.txt": "one\ntwo\nthree\nfour\nfive\n" });
    writeFileSync(join(path, "f.txt"), "one\ntwo\nTHREE\nfour\nfive\n");

    const file = await readRepoFile(path, "f.txt");
    expect(file).toMatchObject({
      kind: "text",
      change: "modified",
      content: "one\ntwo\nTHREE\nfour\nfive\n",
    });
    const lines = file!.diff!.split("\n");
    for (const line of ["one", "two", "four", "five"]) {
      expect(lines).toContain(` ${line}`);
    }
    expect(lines).toContain("-three");
    expect(lines).toContain("+THREE");
  });

  it("returns an untracked file with its content and no diff", async () => {
    const path = committedRepo({ "b.txt": "b\n" });
    writeFileSync(join(path, "u.txt"), "u\n");
    expect(await readRepoFile(path, "u.txt")).toEqual({
      path: "u.txt",
      change: "untracked",
      kind: "text",
      size: 2,
      content: "u\n",
      diff: null,
    });
  });

  it("returns a deleted file with its diff and no content", async () => {
    const path = committedRepo({ "c.txt": "c\n" });
    rmSync(join(path, "c.txt"));

    const file = await readRepoFile(path, "c.txt");
    expect(file).toMatchObject({ kind: "deleted", change: "deleted", content: null });
    expect(file?.diff).toMatch(/^-c$/m);
  });

  it("returns a binary file without content", async () => {
    const path = committedRepo({ "b.txt": "b\n" });
    writeFileSync(join(path, "data.bin"), Buffer.from([0x50, 0x00, 0x4b]));
    expect(await readRepoFile(path, "data.bin")).toMatchObject({
      kind: "binary",
      change: "untracked",
      content: null,
      diff: null,
    });
  });

  it("returns a file over the size cap as too large, without content", async () => {
    const path = committedRepo({ "b.txt": "b\n" });
    writeFileSync(join(path, "big.txt"), Buffer.alloc(MAX_CODE_FILE_BYTES + 1, "a"));
    expect(await readRepoFile(path, "big.txt")).toMatchObject({
      kind: "too-large",
      size: MAX_CODE_FILE_BYTES + 1,
      content: null,
    });
  });

  it("returns a symlink without following it", async (ctx) => {
    const path = committedRepo({ "a.txt": "a\n" });
    try {
      symlinkSync(join(path, "a.txt"), join(path, "link.txt"));
    } catch {
      // Creating symlinks needs privileges on Windows.
      ctx.skip();
      return;
    }
    expect(await readRepoFile(path, "link.txt")).toMatchObject({
      kind: "symlink",
      content: null,
    });
  });

  it("returns null for unsafe paths, ignored files, missing files and paths outside the repo", async () => {
    const path = committedRepo({ ".gitignore": ".env\n", "a.txt": "a\n" });
    writeFileSync(join(path, ".env"), "SECRET=1\n");
    writeFileSync(join(root, "x"), "outside\n");
    for (const relPath of [
      "../x",
      ".git/config",
      "a\\b",
      join(path, "a.txt"),
      ".env",
      "missing.txt",
    ]) {
      expect(await readRepoFile(path, relPath)).toBeNull();
    }
  });

  it("reads a repo with no commits: the branch and new files work, all untracked", async () => {
    const path = join(root, "app");
    mkdirSync(path);
    git(path, "init", "--quiet", "-b", "main");
    writeFileSync(join(path, "new.txt"), "hello\n");

    expect(await readRepoTree(path)).toEqual({
      branch: "main",
      files: [{ path: "new.txt", change: "untracked" }],
    });
    expect(await readRepoFile(path, "new.txt")).toEqual({
      path: "new.txt",
      change: "untracked",
      kind: "text",
      size: 6,
      content: "hello\n",
      diff: null,
    });
  });
});

describe("isSafeCodePath", () => {
  it("accepts a plain repo-relative path", () => {
    expect(isSafeCodePath("src/a.ts")).toBe(true);
  });

  it.each(["", "a//b", "./a", "a/../b", ".GIT/config", ".git", "C:/x", "/x", "a\0b", "a\\b"])(
    "rejects %j",
    (path) => {
      expect(isSafeCodePath(path)).toBe(false);
    },
  );
});

describe("parseStatus", () => {
  it("maps each path to its change, a rename under its new path only", () => {
    expect(parseStatus(" M a.ts\0R  new.ts\0old.ts\0?? u.ts\0")).toEqual(
      new Map([
        ["a.ts", "modified"],
        ["new.ts", "renamed"],
        ["u.ts", "untracked"],
      ]),
    );
  });

  it("reads added and deleted columns", () => {
    expect(parseStatus("A  n.ts\0 D c.ts\0")).toEqual(
      new Map([
        ["n.ts", "added"],
        ["c.ts", "deleted"],
      ]),
    );
  });
});
