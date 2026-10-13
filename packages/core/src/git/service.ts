import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Branches the harness never pushes or deletes, besides the repo's default branch. */
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
  /** Create the branch from `base` (default: the service's main branch). Jira and free-text tasks. */
  | { kind: "new"; base?: string }
  /**
   * Use an existing branch (PR head). The local branch wins; otherwise a
   * tracking branch is created from `<remote>/<branch>`. `fetch` refreshes the
   * remote branch first; with `fetch`, `base` also fetches `<remote>/<base>`,
   * best effort; a failure is ignored.
   */
  | { kind: "existing"; fetch?: boolean; base?: string };

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
  /** Branch to rebase onto and fast-forward: the repo's default branch. Default: the service's main branch. */
  into?: string;
  /**
   * Resolves the conflicts of one rebase stop by editing or deleting the
   * conflicted files in the worktree; the harness stages them and continues.
   * Without it, a conflict aborts the rebase.
   */
  resolve?: (conflict: { files: string[] }) => Promise<void>;
}

/** Outcome of finishing a free-text task into the local default branch. */
export type FinishResult =
  /** `resolved`: every file whose conflicts {@link FinishInput.resolve} resolved. */
  | { status: "merged"; sha: string; resolved: string[] }
  /**
   * The rebase onto the target hit conflicts that were not resolved; it was aborted
   * and nothing changed. `unresolved` says why the resolver did not resolve them.
   */
  | { status: "conflict"; files: string[]; unresolved?: string }
  /** The target moved after the rebase, so a fast-forward was impossible; nothing changed. */
  | { status: "not-fast-forward" };

export interface RemoveWorktreeInput {
  repoPath: string;
  worktreePath: string;
  /** Also delete this local branch (e.g. the free-text `agent/<task-id>` branch). */
  deleteBranch?: string;
  /** The repo's default branch, refused as `deleteBranch`. Default: the service's main branch. */
  mainBranch?: string;
}

export interface GitServiceOptions {
  /** Fallback default branch when a call doesn't name the repo's own. Default `main`. */
  mainBranch?: string;
  /** Remote used for fetch and push. Default `origin`. */
  remote?: string;
}

export type GitService = ReturnType<typeof createGitService>;

/**
 * Accepts git's default commit message without opening an editor. An
 * inherited `GIT_EDITOR` wins over `core.editor`, so it is overridden here.
 */
const NON_INTERACTIVE_EDITOR: NodeJS.ProcessEnv = { GIT_EDITOR: "true" };

/** Rebase stops on conflicts the resolver is asked about before the finish gives up. */
const MAX_CONFLICT_ROUNDS = 20;

/** Conflict marker lines git writes into text files; `=======` is left out (Markdown setext). */
const CONFLICT_MARKER = /^(<<<<<<<|>>>>>>>|\|\|\|\|\|\|\|) /m;

/** Runs git and returns trimmed stdout, throwing {@link GitError} on failure. */
export async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
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

async function succeeds(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await runGit(cwd, args, env);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

/** Whether a rebase is stopped in the worktree (merge or apply backend). */
async function rebaseInProgress(worktree: string): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const path = await runGit(worktree, ["rev-parse", "--git-path", dir]);
    if (existsSync(resolve(worktree, path))) return true;
  }
  return false;
}

/** Files with unmerged index entries: the conflicts of the current stop. */
async function unmergedFiles(worktree: string): Promise<string[]> {
  const out = await runGit(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").filter(Boolean);
}

/**
 * Of `files`, those that still hold conflict markers. Deleted files and
 * binary files (git writes no markers into those) are trusted as they are.
 */
async function leftoverMarkers(worktree: string, files: readonly string[]): Promise<string[]> {
  const left: string[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      content = await readFile(resolve(worktree, file));
    } catch {
      continue; // deleted
    }
    if (content.includes(0)) continue;
    if (CONFLICT_MARKER.test(content.toString("utf8"))) left.push(file);
  }
  return left;
}

/**
 * Runs a rebase command that may stop on the next commit's conflicts.
 * Returns those conflicted files, or `[]` when the rebase finished.
 */
async function advanceRebase(worktree: string, args: readonly string[]): Promise<string[]> {
  try {
    await runGit(worktree, args, NON_INTERACTIVE_EDITOR);
    return [];
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const files = await unmergedFiles(worktree);
    if (files.length > 0) return files;
    throw error;
  }
}

/** Continues a resolved stop; a commit that became empty is skipped. */
async function continueRebase(worktree: string): Promise<string[]> {
  try {
    return await advanceRebase(worktree, ["rebase", "--continue"]);
  } catch (error) {
    const empty =
      (await rebaseInProgress(worktree)) &&
      (await unmergedFiles(worktree)).length === 0 &&
      (await succeeds(worktree, ["diff", "--cached", "--quiet", "HEAD"]));
    if (!empty) throw error;
    return advanceRebase(worktree, ["rebase", "--skip"]);
  }
}

/**
 * Has `resolveConflict` resolve each stop of the rebase, starting with
 * `files`, staging and continuing after each. Any failure aborts the rebase.
 */
async function resolveRebase(
  worktree: string,
  files: string[],
  resolveConflict: NonNullable<FinishInput["resolve"]>,
): Promise<{ resolved: string[] } | { files: string[]; unresolved: string }> {
  const resolved = new Set<string>();
  let current = files;
  try {
    for (let round = 1; current.length > 0; round++) {
      if (round > MAX_CONFLICT_ROUNDS) throw new Error("too many conflicting commits");
      for (const file of current) resolved.add(file);
      await resolveConflict({ files: current });
      // The agent finished the rebase itself.
      if (!(await rebaseInProgress(worktree))) break;
      const markers = await leftoverMarkers(worktree, current);
      if (markers.length > 0) throw new Error(`conflict markers left in ${markers.join(", ")}`);
      await runGit(worktree, ["add", "-A"]);
      const unmerged = await unmergedFiles(worktree);
      if (unmerged.length > 0) throw new Error(`unmerged files remain: ${unmerged.join(", ")}`);
      current = await continueRebase(worktree);
    }
    return { resolved: [...resolved] };
  } catch (error) {
    if (await rebaseInProgress(worktree).catch(() => false)) {
      await runGit(worktree, ["rebase", "--abort"]).catch(() => undefined);
    }
    return {
      files: current,
      unresolved: error instanceof Error ? error.message : String(error),
    };
  }
}

/** `branch` without a `refs/heads/` prefix, as `git symbolic-ref --short` prints it. */
function shortBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
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
 * task, harness commits, squash, the free-text finish into the local default
 * branch, push, per-round diffs and cleanup. Agents never call this; only the
 * harness does, and it never pushes the default branch.
 */
export function createGitService({
  mainBranch = "main",
  remote = "origin",
}: GitServiceOptions = {}) {
  /**
   * Whether the harness refuses to push or delete `branch`: the repo's default
   * branch (`defaultBranch`, else the service's main branch), `main` or `master`.
   */
  function isProtected(branch: string, defaultBranch = mainBranch): boolean {
    const short = shortBranch(branch);
    return short === shortBranch(defaultBranch) || ALWAYS_PROTECTED.includes(short);
  }

  function assertUnprotected(branch: string, defaultBranch?: string): void {
    if (isProtected(branch, defaultBranch)) throw new ProtectedBranchError(shortBranch(branch));
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

  /**
   * Aborts a rebase left in the worktree and checks `branch` out again when
   * HEAD is elsewhere (`git rebase --quit` leaves it detached), dropping the
   * abandoned rebase's edits. The branch itself is never moved.
   */
  async function restoreBranch(worktree: string, branch: string): Promise<void> {
    if (await rebaseInProgress(worktree)) {
      await runGit(worktree, ["rebase", "--abort"]).catch(() => undefined);
    }
    if ((await currentBranch(worktree)) !== shortBranch(branch)) {
      await runGit(worktree, ["checkout", "--force", "--quiet", shortBranch(branch)]);
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

    isProtected,

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
          if (checkout.base) {
            await runGit(repoPath, [
              "fetch",
              remote,
              `+refs/heads/${checkout.base}:refs/remotes/${remote}/${checkout.base}`,
            ]).catch(() => undefined);
          }
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

    /** Commits on HEAD since `base` (`git rev-list --count base..HEAD`). */
    async commitsSince(worktreePath: string, base: string): Promise<number> {
      return Number(await runGit(worktreePath, ["rev-list", "--count", `${base}..HEAD`]));
    },

    /** Unified diff from `from` to `to` (default HEAD), e.g. one implement/fix round. */
    async diff(worktreePath: string, from: string, to = "HEAD"): Promise<string> {
      return runGit(worktreePath, ["diff", "--no-color", "--no-ext-diff", from, to]);
    },

    /**
     * Free-text finish: rebases the task branch onto the local `into` branch
     * (the repo's default branch), then fast-forwards it to the rebased commit
     * (`git merge --ff-only <sha>` when it is checked out in the repo folder)
     * and checks that it now points at it. Each rebase stop on conflicts goes to `resolve`, which
     * edits the files; the harness checks for leftover markers, stages and
     * continues. Without a resolver, or when it fails, the rebase is aborted
     * and the conflicting files are reported; nothing is changed. A resolver
     * that leaves the rebase unfinished (stopped, or quit with HEAD detached)
     * is reported the same way, with the branch checked out again. A rebase a
     * crash left behind is aborted first. Never pushes.
     */
    async finishIntoMain({
      repoPath,
      worktreePath,
      branch,
      into = mainBranch,
      resolve: resolveConflict,
    }: FinishInput): Promise<FinishResult> {
      assertUnprotected(branch, into);
      await restoreBranch(worktreePath, branch);
      let resolved: string[] = [];
      try {
        await runGit(worktreePath, ["rebase", "--quiet", into]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        const files = await unmergedFiles(worktreePath).catch(() => []);
        if (files.length === 0 || !resolveConflict) {
          await runGit(worktreePath, ["rebase", "--abort"]).catch(() => undefined);
          if (files.length === 0) throw error;
          return { status: "conflict", files };
        }
        const outcome = await resolveRebase(worktreePath, files, resolveConflict);
        if ("unresolved" in outcome) return { status: "conflict", ...outcome };
        // Only a finished rebase leaves the branch checked out at the rebased commit.
        if (
          (await rebaseInProgress(worktreePath)) ||
          (await currentBranch(worktreePath)) !== shortBranch(branch)
        ) {
          await restoreBranch(worktreePath, branch);
          return { status: "conflict", files, unresolved: "the rebase was left unfinished" };
        }
        resolved = outcome.resolved;
      }

      const sha = await headSha(worktreePath);
      if (!(await succeeds(repoPath, ["merge-base", "--is-ancestor", into, sha]))) {
        return { status: "not-fast-forward" };
      }
      const mainRef = `refs/heads/${into}`;
      if ((await currentBranch(repoPath)) === into) {
        await runGit(repoPath, ["merge", "--ff-only", "--quiet", sha]);
      } else {
        // The target is not checked out in the repo folder: move the ref, still fast-forward only.
        const old = await runGit(repoPath, ["rev-parse", mainRef]);
        await runGit(repoPath, ["update-ref", mainRef, sha, old]);
      }
      const merged = await runGit(repoPath, ["rev-parse", mainRef]);
      if (merged !== sha) {
        throw new GitError(
          ["rev-parse", mainRef],
          `${into} is at ${merged}, not at the rebased ${sha}`,
          null,
        );
      }
      return { status: "merged", sha, resolved };
    },

    /**
     * Pushes the task branch to the remote under the same name and sets
     * upstream. Harness only, after the user confirms. Refuses `defaultBranch`
     * (the repo's default branch), `main` and `master`.
     */
    async push(worktreePath: string, branch: string, defaultBranch?: string): Promise<void> {
      assertUnprotected(branch, defaultBranch);
      await runGit(worktreePath, [
        "push",
        "--quiet",
        "--set-upstream",
        remote,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ]);
    },

    /**
     * URL of the remote used for fetch and push (`git remote get-url`), or
     * `null` when the repo has none.
     */
    async remoteUrl(cwd: string): Promise<string | null> {
      try {
        return (await runGit(cwd, ["remote", "get-url", remote])) || null;
      } catch (error) {
        if (error instanceof GitError) return null;
        throw error;
      }
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
      mainBranch: defaultBranch,
    }: RemoveWorktreeInput): Promise<void> {
      if (deleteBranch) assertUnprotected(deleteBranch, defaultBranch);
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
