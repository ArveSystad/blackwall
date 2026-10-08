import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What a folder's `.git` entry says about it. */
export type GitDirKind =
  /** A normal clone or `git init` (`.git` is a folder, or a `gitdir:` file pointing elsewhere). */
  | "repo"
  /** A linked worktree of another repo (`.git` file pointing into `.git/worktrees/`). */
  | "worktree"
  /** No `.git` entry. */
  | "none";

const WORKTREE_GITDIR = /[\\/]\.git[\\/]worktrees[\\/]/;

/** Classifies a folder by its `.git` entry, without running git. */
export async function gitDirKind(path: string): Promise<GitDirKind> {
  const dotGit = join(path, ".git");
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return "repo";
    const content = await readFile(dotGit, "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(content)?.[1];
    if (!gitdir) return "none";
    return WORKTREE_GITDIR.test(gitdir) ? "worktree" : "repo";
  } catch {
    return "none";
  }
}

/** URL of the repo's `origin` remote, or `null` when it has none. */
export async function readOriginRemote(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", path, "remote", "get-url", "origin"], {
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
