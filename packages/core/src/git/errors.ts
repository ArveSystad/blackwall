// A value import that cycles with service.ts: read `GitError` only inside function bodies.
import { GitError } from "./service.js";

/** What went wrong in a failed git command, read from git's own message. */
export type GitErrorKind =
  /** A `.lock` file exists: another git process, or one that died, holds it. */
  | "lock"
  /** A ref could not be updated: it moved (compare-and-swap) or a name clashes. Never retried. */
  | "ref-conflict"
  | "auth"
  | "network"
  /** The remote branch has commits the pushed branch does not. */
  | "non-fast-forward"
  /** `worktree add -b`: the branch exists, e.g. created by an earlier attempt. */
  | "branch-exists"
  /** `worktree add`: the branch is checked out in another worktree. */
  | "branch-checked-out"
  /** `worktree add`: the folder exists and is not empty. */
  | "path-exists"
  /** `worktree add`: the path is registered as a worktree whose folder is gone. */
  | "stale-worktree"
  /** `commit`: one of the repo's hooks ({@link GitError.hook}) rejected the commit. Never read from stderr. */
  | "hook-rejected"
  | "unknown";

/** The commit hooks the harness tells apart when a commit is rejected. */
export type GitHook = "pre-commit" | "commit-msg";

/** Hook output kept by {@link hookOutput}. */
const MAX_HOOK_OUTPUT = 20_000;

/** Hook output shown by {@link describeGitError}. */
const MAX_DESCRIBED_HOOK_OUTPUT = 2_000;

/** First match wins; `lock` before `ref-conflict`, `auth` before `network`. */
const KINDS: readonly [GitErrorKind, RegExp][] = [
  ["lock", /Unable to create '[^']+\.lock': File exists/],
  ["ref-conflict", /cannot lock ref/],
  [
    "auth",
    /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|Repository not found/,
  ],
  [
    "network",
    /Could not resolve host|Connection timed out|Connection reset|unable to access|early EOF|RPC failed|The remote end hung up/,
  ],
  ["non-fast-forward", /\[rejected\].*\((non-fast-forward|fetch first)\)|Updates were rejected/],
  ["branch-exists", /a branch named '[^']+' already exists/],
  ["branch-checked-out", /is already checked out at|is already used by worktree at/],
  ["path-exists", /'[^']+' already exists/],
  ["stale-worktree", /missing but already registered worktree|is a missing but locked worktree/],
];

/** Classifies git's stderr. Git must run with `LC_ALL=C` so the messages are in English. */
export function classifyGitError(stderr: string): GitErrorKind {
  return KINDS.find(([, pattern]) => pattern.test(stderr))?.[0] ?? "unknown";
}

/** The `.lock` file a `lock` error names, as git printed it (absolute or relative to its cwd). */
export function lockPath(stderr: string): string | undefined {
  return /Unable to create '([^']+\.lock)': File exists/.exec(stderr)?.[1];
}

/** The ref a `cannot lock ref` error names. */
export function refName(stderr: string): string | undefined {
  return /cannot lock ref '([^']+)'/.exec(stderr)?.[1];
}

/** Drops the user and password from URLs (`https://user:pass@host` → `https://host`). */
function withoutCredentials(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//");
}

function firstLine(stderr: string): string {
  return (
    stderr
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

/** The last `max` characters of `text`, with a marker saying how much was cut. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[… ${text.length - max} earlier characters cut]\n${text.slice(-max)}`;
}

/**
 * What a failed command printed, stdout then stderr, trimmed and cut to the
 * last {@link MAX_HOOK_OUTPUT} characters. Hooks (eslint, commitlint) often
 * print to stdout only.
 */
export function hookOutput(error: GitError): string {
  const text = [error.stdout.trim(), error.stderr.trim()].filter(Boolean).join("\n");
  return tail(text, MAX_HOOK_OUTPUT);
}

/**
 * What a failed git command means for the user and what to do about it, with
 * git's first line in parentheses and credentials stripped. Kinds without
 * advice keep the error's own message. A hook rejection carries the tail of
 * the hook's output instead.
 */
export function describeGitError(error: GitError): string {
  const advice = adviceFor(error);
  if (!advice) return withoutCredentials(error.message);
  if (error.kind === "hook-rejected") {
    const output = hookOutput(error);
    if (!output) return advice;
    return `${advice}\n\n${withoutCredentials(tail(output, MAX_DESCRIBED_HOOK_OUTPUT))}`;
  }
  const line = withoutCredentials(firstLine(error.stderr));
  return line ? `${advice} (${line})` : advice;
}

/** A thrown value as a message: git errors described, other errors by their message. */
export function errorMessage(error: unknown): string {
  if (error instanceof GitError) return describeGitError(error);
  return error instanceof Error ? error.message : String(error);
}

function adviceFor({ kind, stderr, staleLockRemoved, hook }: GitError): string | undefined {
  switch (kind) {
    case "hook-rejected":
      return hook === "commit-msg"
        ? "The repo's commit-msg hook rejected the commit message. Retry to have the summarizer rewrite it, or adjust the hook; blackwall never bypasses hooks."
        : "The repo's pre-commit hook rejected the commit. Fix what it reports in the worktree, then retry; blackwall never bypasses hooks.";
    case "auth":
      return "Git could not authenticate to the remote. Set up git credentials (credential manager or SSH key) for it; this is not the blackwall token.";
    case "lock": {
      const path = lockPath(stderr) ?? "a .lock file";
      return staleLockRemoved
        ? `Removed a stale git lock ${path} left by an earlier git process. Retry.`
        : `Another git process holds ${path}. Blackwall removes it automatically once it is older than 2 minutes and no git command of its own is running; retry then, or close the other git program.`;
    }
    case "ref-conflict":
      return `Git could not update ${refName(stderr) ?? "a ref"}: it moved while blackwall was working, or a branch with a clashing name exists. Retry; if it persists, check the branch in the repo.`;
    case "non-fast-forward":
      return "The remote branch has commits this branch does not. Pull or rebase it, then finish again.";
    case "network":
      return "Could not reach the remote. Check the connection and retry.";
    case "branch-checked-out": {
      const at = /(?:checked out|used by worktree) at '([^']+)'/.exec(stderr)?.[1];
      return `The branch is checked out in another worktree${at ? ` (${at})` : ""}. Switch that worktree to another branch or remove it, then retry.`;
    }
    default:
      return undefined;
  }
}
