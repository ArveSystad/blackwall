import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Branches the harness never pushes or deletes, besides the configured main branch. */
const ALWAYS_PROTECTED = ["main", "master"];

/** A git command that failed. `stderr` is git's own message. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    this.name = "GitError";
  }
}

/** The harness refused a git action (pushing main, deleting a protected branch, …). */
export class ProtectedBranchError extends Error {
  constructor(readonly branch: string) {
    super(`Refusing to push or delete protected branch "${branch}"`);
    this.name = "ProtectedBranchError";
  }
}

/** How a worktree gets its branch. */
export type WorktreeCheckout =
  /** Create the branch from `base` (default: the main branch). Jira and free-text tasks. */
  | { kind: "new"; base?: string }
  /**
   * Use an existing branch (PR head). The local branch wins; otherwise a
   * tracking branch is created from `<remote>/<branch>`. `fetch` refreshes the
   * remote branch first.
   */
  | { kind: "existing"; fetch?: boolean };

export interface CreateWorktreeInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
  checkout: WorktreeCheckout;
}

export interface Worktree {
  path: string;
  branch: string;
  /** HEAD when the worktree was created: the base for squash and the task diff. */
  baseSha: string;
}

export interface FinishInput {
  repoPath: string;
  worktreePath: string;
  branch: string;
}

/** Outcome of finishing a free-text task into local main. */
export type FinishResult =
  | { status: "merged"; sha: string }
  /** The rebase onto main hit conflicts; it was aborted and nothing changed. */
  | { status: "conflict"; files: string[] }
  /** Main moved after the rebase, so a fast-forward was impossible; nothing changed. */
  | { status: "not-fast-forward" };

export interface RemoveWorktreeInput {
  repoPath: string;
  worktreePath: string;
  /** Also delete this local branch (e.g. the free-text `agent/<task-id>` branch). */
  deleteBranch?: string;
}

export interface GitServiceOptions {
  /** The repo's main branch. Default `main`. */
  mainBranch?: string;
  /** Remote used for fetch and push. Default `origin`. */
  remote?: string;
}

export type GitService = ReturnType<typeof createGitService>;

/** Runs git and returns trimmed stdout, throwing {@link GitError} on failure. */
export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trimEnd();
  } catch (error) {
    const failure = error as { stderr?: string; code?: number | string };
    throw new GitError(
      args,
      failure.stderr ?? String(error),
      typeof failure.code === "number" ? failure.code : null,
    );
  }
}

async function succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await runGit(cwd, args);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const full = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

/**
 * Every git operation the pipeline needs, via the git CLI: one worktree per
 * task, harness commits, squash, the free-text finish into local main, push,
 * per-round diffs and cleanup. Agents never call this; only the harness does,
 * and it never pushes the main branch.
 */
export function createGitService({
  mainBranch = "main",
  remote = "origin",
}: GitServiceOptions = {}) {
  const protectedBranches = new Set([mainBranch, ...ALWAYS_PROTECTED]);

  function assertUnprotected(branch: string): void {
    const name = branch.replace(/^refs\/heads\//, "");
    if (protectedBranches.has(name)) throw new ProtectedBranchError(name);
  }

  async function headSha(cwd: string): Promise<string> {
    return runGit(cwd, ["rev-parse", "HEAD"]);
  }

  async function currentBranch(cwd: string): Promise<string | null> {
    try {
      return (await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])) || null;
    } catch {
      return null; // detached HEAD
    }
  }

  /** Branch checked out in the worktree at `path`, or `undefined` when no worktree is there. */
  async function worktreeAt(repoPath: string, path: string): Promise<string | null | undefined> {
    const list = await runGit(repoPath, ["worktree", "list", "--porcelain"]);
    for (const entry of list.split(/\n\n+/)) {
      const wt = /^worktree (.+)$/m.exec(entry)?.[1];
      if (!wt || !samePath(wt, path)) continue;
      return /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] ?? null;
    }
    return undefined;
  }

  return {
    mainBranch,

    headSha,

    /**
     * Creates the task's worktree on its branch. Idempotent: an existing
     * worktree at the same path on the same branch is returned as-is, so a
     * restarted task picks up where it left off.
     */
    async createWorktree({
      repoPath,
      worktreePath,
      branch,
      checkout,
    }: CreateWorktreeInput): Promise<Worktree> {
      const existing = await worktreeAt(repoPath, worktreePath);
      if (existing !== undefined) {
        if (existing !== branch) {
          throw new GitError(
            ["worktree", "add", worktreePath],
            `a worktree already exists at ${worktreePath} on ${existing ?? "a detached HEAD"}`,
            null,
          );
        }
        return { path: worktreePath, branch, baseSha: await headSha(worktreePath) };
      }

      await mkdir(dirname(worktreePath), { recursive: true });
      if (checkout.kind === "new") {
        await runGit(repoPath, [
          "worktree",
          "add",
          "-b",
          branch,
          worktreePath,
          checkout.base ?? mainBranch,
        ]);
      } else {
        const remoteRef = `refs/remotes/${remote}/${branch}`;
        if (checkout.fetch) {
          await runGit(repoPath, ["fetch", remote, `+refs/heads/${branch}:${remoteRef}`]);
        }
        if (await succeeds(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) {
          await runGit(repoPath, ["worktree", "add", worktreePath, branch]);
        } else {
          await runGit(repoPath, [
            "worktree",
            "add",
            "--track",
            "-b",
            branch,
            worktreePath,
            remoteRef,
          ]);
        }
      }
      return { path: worktreePath, branch, baseSha: await headSha(worktreePath) };
    },

    /**
     * Stages everything (`git add -A`) and commits with the caller's message.
     * Returns the new commit's sha, or `null` when there was nothing to commit.
     */
    async commitAll(worktreePath: string, message: string): Promise<string | null> {
      await runGit(worktreePath, ["add", "-A"]);
      if (await succeeds(worktreePath, ["diff", "--cached", "--quiet"])) return null;
      await runGit(worktreePath, ["commit", "--quiet", "-m", message]);
      return headSha(worktreePath);
    },

    /**
     * Stages everything (`git add -A`) and returns the staged diff against
     * HEAD: what the next {@link commitAll} would commit. Empty when nothing
     * changed.
     */
    async stagedDiff(worktreePath: string): Promise<string> {
      await runGit(worktreePath, ["add", "-A"]);
      return runGit(worktreePath, ["diff", "--cached", "--no-color", "--no-ext-diff"]);
    },

    /**
     * Squashes every commit since `sinceSha` (usually the worktree's `baseSha`)
     * into one with `message`. Returns the new sha, or `null` when there was
     * nothing after `sinceSha`.
     */
    async squash(worktreePath: string, sinceSha: string, message: string): Promise<string | null> {
      if ((await headSha(worktreePath)) === (await runGit(worktreePath, ["rev-parse", sinceSha]))) {
        return null;
      }
      await runGit(worktreePath, ["reset", "--soft", sinceSha]);
      await runGit(worktreePath, ["commit", "--quiet", "--allow-empty", "-m", message]);
      return headSha(worktreePath);
    },

    /** The commit where HEAD forked from `ref` (`git merge-base HEAD <ref>`). */
    async mergeBase(worktreePath: string, ref: string): Promise<string> {
      return runGit(worktreePath, ["merge-base", "HEAD", ref]);
    },

    /** Unified diff from `from` to `to` (default HEAD), e.g. one implement/fix round. */
    async diff(worktreePath: string, from: string, to = "HEAD"): Promise<string> {
      return runGit(worktreePath, ["diff", "--no-color", "--no-ext-diff", from, to]);
    },

    /**
     * Free-text finish: rebases the task branch onto local main, then
     * fast-forwards main to it (`git merge --ff-only` when main is checked out
     * in the repo folder). On a rebase conflict the rebase is aborted and the
     * conflicting files are reported; nothing is changed. Never pushes.
     */
    async finishIntoMain({ repoPath, worktreePath, branch }: FinishInput): Promise<FinishResult> {
      assertUnprotected(branch);
      try {
        await runGit(worktreePath, ["rebase", "--quiet", mainBranch]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        const unmerged = await runGit(worktreePath, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]).catch(() => "");
        await runGit(worktreePath, ["rebase", "--abort"]).catch(() => undefined);
        const files = unmerged.split("\n").filter(Boolean);
        if (files.length === 0) throw error;
        return { status: "conflict", files };
      }

      const sha = await headSha(worktreePath);
      if (!(await succeeds(repoPath, ["merge-base", "--is-ancestor", mainBranch, sha]))) {
        return { status: "not-fast-forward" };
      }
      if ((await currentBranch(repoPath)) === mainBranch) {
        await runGit(repoPath, ["merge", "--ff-only", "--quiet", branch]);
      } else {
        // Main is not checked out in the repo folder: move the ref, still fast-forward only.
        const old = await runGit(repoPath, ["rev-parse", `refs/heads/${mainBranch}`]);
        await runGit(repoPath, ["update-ref", `refs/heads/${mainBranch}`, sha, old]);
      }
      return { status: "merged", sha };
    },

    /**
     * Pushes the task branch to the remote under the same name and sets
     * upstream. Harness only, after the user confirms. Refuses main.
     */
    async push(worktreePath: string, branch: string): Promise<void> {
      assertUnprotected(branch);
      await runGit(worktreePath, [
        "push",
        "--quiet",
        "--set-upstream",
        remote,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ]);
    },

    /**
     * Removes the task's worktree (forcing past uncommitted changes) and prunes
     * stale entries, optionally deleting its local branch. Safe to call when
     * the folder is already gone.
     */
    async removeWorktree({
      repoPath,
      worktreePath,
      deleteBranch,
    }: RemoveWorktreeInput): Promise<void> {
      if (deleteBranch) assertUnprotected(deleteBranch);
      if ((await worktreeAt(repoPath, worktreePath)) !== undefined && existsSync(worktreePath)) {
        await runGit(repoPath, ["worktree", "remove", "--force", worktreePath]);
      }
      await runGit(repoPath, ["worktree", "prune"]);
      if (
        deleteBranch &&
        (await succeeds(repoPath, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${deleteBranch}`,
        ]))
      ) {
        await runGit(repoPath, ["branch", "-D", deleteBranch]);
      }
    },
  };
}
