import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { classifyGitError, lockPath, type GitErrorKind, type GitHook } from "./errors.js";

const execFileAsync = promisify(execFile);

/** Branches the harness never pushes or deletes, besides the repo's default branch. */
const ALWAYS_PROTECTED = ["main", "master"];

/**
 * A git command that failed. `stderr` is git's own message; `kind` classifies
 * it, or is `hook-rejected` when `hook` names the commit hook that rejected it.
 */
export class GitError extends Error {
  readonly kind: GitErrorKind;
  /** What the command printed to stdout; hooks often report there. */
  readonly stdout: string;
  /** The commit hook that rejected the commit, found by {@link rejectingHook}. */
  readonly hook: GitHook | undefined;
  /** A `lock` failure whose stale lock file {@link runGit} removed; a retry can succeed. */
  staleLockRemoved = false;

  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
    { stdout = "", hook }: { stdout?: string; hook?: GitHook } = {},
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
    this.name = "GitError";
    this.stdout = stdout;
    this.hook = hook;
    this.kind = hook ? "hook-rejected" : classifyGitError(stderr);
  }
}

/** Whether `error` is a commit rejected by a repo hook (by `hook`, when given). */
export function isHookRejection(error: unknown, hook?: GitHook): error is GitError {
  return (
    error instanceof GitError &&
    error.kind === "hook-rejected" &&
    (hook === undefined || error.hook === hook)
  );
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

/** Outcome of {@link GitService.push}. */
export type PushResult =
  /**
   * `integrated`: the remote branch had moved on, so the branch was rebased onto
   * it first; `resolved`: the files whose conflicts that rebase resolved.
   */
  | { status: "pushed"; integrated: boolean; resolved: string[] }
  /** The rebase onto the remote branch hit conflicts that were not resolved; nothing was pushed. */
  | { status: "conflict"; files: string[]; unresolved?: string };

export interface PushOptions {
  /**
   * When the remote branch has commits this one does not, fetch it, rebase
   * onto it (conflicts go to `resolve`, as in {@link FinishInput}) and push
   * again, never forcing. Without it, the rejection is thrown.
   */
  integrate?: { resolve?: FinishInput["resolve"] };
}

type RebaseResult =
  | { status: "rebased"; resolved: string[] }
  | { status: "conflict"; files: string[]; unresolved?: string };

export interface RemoveWorktreeInput {
  repoPath: string;
  worktreePath: string;
  /** Also delete this local branch (e.g. the free-text `agent/<task-id>` branch). */
  deleteBranch?: string;
  /** The repo's default branch, refused as `deleteBranch`. Default: the service's main branch. */
  mainBranch?: string;
}

/** A worktree's state as git tree objects: HEAD, the staged index and the full working state. */
export type WorktreeSnapshot = { head: string; index: string; worktree: string };

/** Whether two snapshots name the same HEAD, staged index and working state. */
export function sameSnapshot(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return a.head === b.head && a.index === b.index && a.worktree === b.worktree;
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

/**
 * Commands that take their lock before writing anything, so a lock failure
 * changed nothing and running them again is safe (`update-ref` checks the old
 * value; the harness only runs `merge --ff-only`).
 */
const LOCK_RETRY_COMMANDS: ReadonlySet<string> = new Set([
  "add",
  "commit",
  "reset",
  "checkout",
  "branch",
  "update-ref",
  "merge",
  "fetch",
  "push",
]);

/** Commands retried after a network failure. */
const NETWORK_RETRY_COMMANDS: ReadonlySet<string> = new Set(["fetch", "push"]);

/** Waits before each retry of a lock or network failure. */
const TRANSIENT_RETRY_MS = [200, 600, 1500];

/** A lock file older than this, with no git command of the harness running, is stale. */
const STALE_LOCK_MS = 120_000;

/** {@link runGit} calls running in this process, across all repos. */
let gitInFlight = 0;

async function execGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      // English messages, so classifyGitError can read them.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", LANG: "C", ...env },
    });
    return stdout.trimEnd();
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    throw new GitError(
      args,
      failure.stderr ?? String(error),
      typeof failure.code === "number" ? failure.code : null,
      { stdout: failure.stdout ?? "" },
    );
  }
}

/**
 * Deletes the lock file a `lock` failure names when it is stale: inside the
 * repo's git directory, older than {@link STALE_LOCK_MS}, and no other git
 * command of this process is running. Returns whether it was removed.
 */
async function clearStaleLock(cwd: string, stderr: string): Promise<boolean> {
  const named = lockPath(stderr);
  if (!named || gitInFlight > 1) return false;
  try {
    const lock = resolve(cwd, named);
    const gitDir = resolve(cwd, await execGit(cwd, ["rev-parse", "--git-common-dir"]));
    const inside = relative(gitDir, lock);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) return false;
    if (Date.now() - (await stat(lock)).mtimeMs < STALE_LOCK_MS) return false;
    if (gitInFlight > 1) return false;
    await unlink(lock);
    return true;
  } catch {
    return false; // gone, busy (held open on Windows) or not a repo
  }
}

/**
 * Runs git and returns trimmed stdout, throwing {@link GitError} on failure.
 * A stale lock file is removed (see {@link clearStaleLock}). Lock failures of
 * {@link LOCK_RETRY_COMMANDS} and network failures of fetch and push are
 * retried up to 3 times; nothing else is, so rebases and worktree commands
 * fail at once.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  gitInFlight++;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await execGit(cwd, args, env);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        const removed = error.kind === "lock" && (await clearStaleLock(cwd, error.stderr));
        const command = args[0] ?? "";
        const retryable =
          (error.kind === "lock" && LOCK_RETRY_COMMANDS.has(command)) ||
          (error.kind === "network" && NETWORK_RETRY_COMMANDS.has(command));
        if (!retryable || attempt >= TRANSIENT_RETRY_MS.length) {
          error.staleLockRemoved = removed;
          throw error;
        }
        if (!removed) await sleep(TRANSIENT_RETRY_MS[attempt]);
      }
    }
  } finally {
    gitInFlight--;
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

/** `git hook` does not exist: git older than 2.36. */
const NO_GIT_HOOK = /is not a git command|unknown subcommand/;

/**
 * Which hook rejected a failed commit of `message`, found by running the
 * hooks again on their own in git's order: `pre-commit`, then `commit-msg` on
 * a temp copy of the message. `undefined` when neither fails or this git has
 * no `git hook`. Git prints nothing of its own when a hook rejects a commit,
 * so its output cannot tell.
 */
async function rejectingHook(worktree: string, message: string): Promise<GitHook | undefined> {
  /** Whether the hook fails; `undefined` when this git has no `git hook`. */
  const fails = async (args: readonly string[]): Promise<boolean | undefined> => {
    try {
      await runGit(worktree, ["hook", "run", "--ignore-missing", ...args]);
      return false;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return NO_GIT_HOOK.test(error.stderr) ? undefined : true;
    }
  };
  const preCommit = await fails(["pre-commit"]);
  if (preCommit === undefined) return undefined;
  if (preCommit) return "pre-commit";
  const dir = await mkdtemp(join(tmpdir(), "blackwall-msg-"));
  try {
    const file = join(dir, "COMMIT_EDITMSG");
    await writeFile(file, message.endsWith("\n") ? message : `${message}\n`);
    return (await fails(["commit-msg", "--", file])) ? "commit-msg" : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `git commit --quiet <flags> -m <message>`, with the repo's hooks; never
 * `--no-verify`. A failure git cannot explain is checked for a hook
 * rejection ({@link rejectingHook}); one is thrown as a `hook-rejected`
 * {@link GitError} with git's args and both git's and the hook's output.
 */
async function commit(worktree: string, flags: readonly string[], message: string): Promise<void> {
  try {
    await runGit(worktree, ["commit", "--quiet", ...flags, "-m", message]);
  } catch (error) {
    if (!(error instanceof GitError) || error.kind !== "unknown") throw error;
    const hook = await rejectingHook(worktree, message);
    if (!hook) throw error;
    throw new GitError(error.args, error.stderr, error.exitCode, { stdout: error.stdout, hook });
  }
}

/** `branch` without a `refs/heads/` prefix, as `git symbolic-ref --short` prints it. */
function shortBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, "");
}

async function isEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
  } catch {
    return false;
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

  /**
   * Rebases `branch` onto `onto` in the worktree, after aborting a rebase a
   * crash left behind. Conflicts go to `resolveConflict`; without it, or when
   * it fails or leaves the rebase unfinished, the rebase is aborted, the branch
   * checked out again and the conflicting files reported.
   */
  async function rebaseOnto(
    worktree: string,
    branch: string,
    onto: string,
    resolveConflict: FinishInput["resolve"],
  ): Promise<RebaseResult> {
    await restoreBranch(worktree, branch);
    try {
      await runGit(worktree, ["rebase", "--quiet", onto]);
      return { status: "rebased", resolved: [] };
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const files = await unmergedFiles(worktree).catch(() => []);
      if (files.length === 0 || !resolveConflict) {
        await runGit(worktree, ["rebase", "--abort"]).catch(() => undefined);
        if (files.length === 0) throw error;
        return { status: "conflict", files };
      }
      const outcome = await resolveRebase(worktree, files, resolveConflict);
      if ("unresolved" in outcome) return { status: "conflict", ...outcome };
      // Only a finished rebase leaves the branch checked out at the rebased commit.
      if (
        (await rebaseInProgress(worktree)) ||
        (await currentBranch(worktree)) !== shortBranch(branch)
      ) {
        await restoreBranch(worktree, branch);
        return { status: "conflict", files, unresolved: "the rebase was left unfinished" };
      }
      return { status: "rebased", resolved: outcome.resolved };
    }
  }

  /**
   * `git worktree add <args>` for the worktree at `worktreePath`. A stale
   * registration is pruned, and an empty leftover folder removed, before one
   * more try.
   */
  async function addWorktree(
    repoPath: string,
    worktreePath: string,
    args: readonly string[],
  ): Promise<void> {
    try {
      await runGit(repoPath, ["worktree", "add", ...args]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (error.kind === "stale-worktree") {
        await runGit(repoPath, ["worktree", "prune"]);
      } else if (error.kind === "path-exists" && (await isEmptyDir(worktreePath))) {
        await rmdir(worktreePath);
      } else {
        throw error;
      }
      await runGit(repoPath, ["worktree", "add", ...args]);
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
     * restarted task picks up where it left off. A registration whose folder
     * is gone is pruned, and a new branch an earlier failed attempt left
     * behind is reused.
     */
    async createWorktree({
      repoPath,
      worktreePath,
      branch,
      checkout,
    }: CreateWorktreeInput): Promise<Worktree> {
      let existing = await worktreeAt(repoPath, worktreePath);
      if (existing !== undefined && !existsSync(worktreePath)) {
        await runGit(repoPath, ["worktree", "prune"]);
        existing = await worktreeAt(repoPath, worktreePath);
      }
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
        try {
          await addWorktree(repoPath, worktreePath, [
            "-b",
            branch,
            worktreePath,
            checkout.base ?? mainBranch,
          ]);
        } catch (error) {
          if (!(error instanceof GitError) || error.kind !== "branch-exists") throw error;
          await addWorktree(repoPath, worktreePath, [worktreePath, branch]);
        }
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
     * The repo's hooks run; a rejection throws a `hook-rejected` {@link GitError}.
     */
    async commitAll(worktreePath: string, message: string): Promise<string | null> {
      await runGit(worktreePath, ["add", "-A"]);
      if (await succeeds(worktreePath, ["diff", "--cached", "--quiet"])) return null;
      await commit(worktreePath, [], message);
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
     * nothing after `sinceSha`. The repo's hooks run; when the commit fails
     * (a rejection throws a `hook-rejected` {@link GitError}), the branch is
     * reset to its old HEAD, so it is never left collapsed to `sinceSha`.
     */
    async squash(worktreePath: string, sinceSha: string, message: string): Promise<string | null> {
      const oldHead = await headSha(worktreePath);
      if (oldHead === (await runGit(worktreePath, ["rev-parse", sinceSha]))) return null;
      await runGit(worktreePath, ["reset", "--soft", sinceSha]);
      try {
        await commit(worktreePath, ["--allow-empty"], message);
      } catch (error) {
        await runGit(worktreePath, ["reset", "--soft", oldHead]);
        throw error;
      }
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
      const rebased = await rebaseOnto(worktreePath, branch, into, resolveConflict);
      if (rebased.status === "conflict") return rebased;
      const { resolved } = rebased;

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
     * upstream; never forces. Harness only, after the user confirms. Refuses
     * `defaultBranch` (the repo's default branch), `main` and `master`. With
     * `integrate`, a push rejected because the remote branch moved on fetches
     * it, rebases onto `<remote>/<branch>` and pushes again; conflicts the
     * resolver did not resolve are returned and nothing is pushed.
     */
    async push(
      worktreePath: string,
      branch: string,
      defaultBranch?: string,
      { integrate }: PushOptions = {},
    ): Promise<PushResult> {
      assertUnprotected(branch, defaultBranch);
      const args = [
        "push",
        "--quiet",
        "--set-upstream",
        remote,
        `refs/heads/${branch}:refs/heads/${branch}`,
      ];
      try {
        await runGit(worktreePath, args);
        return { status: "pushed", integrated: false, resolved: [] };
      } catch (error) {
        if (!integrate || !(error instanceof GitError) || error.kind !== "non-fast-forward") {
          throw error;
        }
      }
      const tracking = `refs/remotes/${remote}/${branch}`;
      await runGit(worktreePath, ["fetch", "--quiet", remote, `+refs/heads/${branch}:${tracking}`]);
      const rebased = await rebaseOnto(worktreePath, branch, tracking, integrate.resolve);
      if (rebased.status === "conflict") return rebased;
      await runGit(worktreePath, args);
      return { status: "pushed", integrated: true, resolved: rebased.resolved };
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
     * Whether `branch` exists locally or as a remote-tracking branch of the
     * remote. Never fetches, so a remote branch not fetched yet is missed.
     */
    async branchExists(cwd: string, branch: string): Promise<boolean> {
      for (const ref of [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]) {
        if (await succeeds(cwd, ["show-ref", "--verify", "--quiet", ref])) return true;
      }
      return false;
    },

    /**
     * Renames the branch checked out in the worktree (`git branch -m`), e.g. a
     * free-text task's `agent/<task-id>` before its first push. Refuses
     * `defaultBranch` (the repo's default branch), `main` and `master` on
     * either side.
     */
    async renameBranch(
      worktreePath: string,
      from: string,
      to: string,
      defaultBranch?: string,
    ): Promise<void> {
      assertUnprotected(from, defaultBranch);
      assertUnprotected(to, defaultBranch);
      await runGit(worktreePath, ["branch", "-m", from, to]);
    },

    /**
     * Records the worktree at `path` as three tree objects: HEAD, the real index
     * (`git write-tree`) and the full working state, untracked non-ignored files
     * included, built in a temporary index so the real one is never touched.
     */
    async snapshotWorktree(path: string): Promise<WorktreeSnapshot> {
      const head = await headSha(path);
      const index = await runGit(path, ["write-tree"]);
      const dir = await mkdtemp(join(tmpdir(), "blackwall-snap-"));
      try {
        const env = { GIT_INDEX_FILE: join(dir, "index") };
        await runGit(path, ["read-tree", head], env);
        await runGit(path, ["add", "-A"], env);
        const worktree = await runGit(path, ["write-tree"], env);
        return { head, index, worktree };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    /**
     * Puts the worktree at `path` back to `snapshot`: resets HEAD and its branch
     * to the snapshot's head, writes the files of its working state, removes the
     * untracked files, then restores the real index. The staged, unstaged and
     * untracked split comes back exactly. Ignored files are not touched.
     */
    async restoreWorktree(path: string, snapshot: WorktreeSnapshot): Promise<void> {
      await runGit(path, ["reset", "--hard", snapshot.head]);
      await runGit(path, ["read-tree", snapshot.worktree]);
      await runGit(path, ["checkout-index", "-a", "-f"]);
      await runGit(path, ["clean", "-fd"]);
      await runGit(path, ["read-tree", snapshot.index]);
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
