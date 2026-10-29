import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoSync } from "@blackwall/shared";
import { GitError, runGit } from "../git/service.js";

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

async function refExists(path: string, ref: string): Promise<boolean> {
  try {
    await runGit(path, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/**
 * How the local `branch` compares with `origin/<branch>`, whatever is checked
 * out. Reads the remote-tracking ref as of the last fetch; never fetches.
 * `null` when either ref is missing.
 */
export async function readBranchSync(path: string, branch: string): Promise<RepoSync | null> {
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  if (!(await refExists(path, local)) || !(await refExists(path, remote))) return null;
  const counts = await runGit(path, [
    "rev-list",
    "--left-right",
    "--count",
    `${remote}...${local}`,
  ]);
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return { branch, ahead: ahead ?? 0, behind: behind ?? 0 };
}

/** Points the repo's `origin` remote at `url`. */
export async function setOriginRemote(path: string, url: string): Promise<void> {
  await runGit(path, ["remote", "set-url", "origin", url]);
}

/**
 * Paths of the repo's linked worktrees as git records them, without the main
 * worktree. Includes worktrees whose folder is gone or moved.
 */
export async function listWorktreePaths(path: string): Promise<string[]> {
  const output = await runGit(path, ["worktree", "list", "--porcelain"]);
  const paths = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  return paths.slice(1);
}

/** Re-links moved worktrees (at their new `paths`) with the repo at `path`, both ways. */
export async function repairWorktrees(path: string, paths: readonly string[]): Promise<void> {
  await runGit(path, ["worktree", "repair", ...paths]);
}

/**
 * Pushes the local `branch` to `origin/<branch>`. User-initiated from the
 * Backlog only; pushes the main branch; never forces.
 */
export async function pushBranch(path: string, branch: string): Promise<void> {
  await runGit(path, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
}
