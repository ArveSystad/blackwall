import { describe, expect, it } from "vitest";
import { classifyGitError, describeGitError, lockPath, refName } from "./errors.js";
import { GitError } from "./service.js";

const INDEX_LOCK = `fatal: Unable to create '/repo/.git/index.lock': File exists.

Another git process seems to be running in this repository, e.g.
an editor opened by 'git commit'. Please make sure all processes
are terminated then try again. If it still fails, a git process
may have crashed in this repository earlier:
remove the file manually to continue.
`;

const REF_LOCK = `error: cannot lock ref 'refs/heads/agent/t1': Unable to create 'C:/Code/app/.git/refs/heads/agent/t1.lock': File exists.`;

const SAMPLES: [string, string, ReturnType<typeof classifyGitError>][] = [
  ["index lock", INDEX_LOCK, "lock"],
  ["ref lock", REF_LOCK, "lock"],
  [
    "compare-and-swap mismatch",
    "fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': is at 1111 but expected 2222",
    "ref-conflict",
  ],
  [
    "D/F clash",
    "error: cannot lock ref 'refs/heads/a': 'refs/heads/a/b' exists; cannot create 'refs/heads/a'",
    "ref-conflict",
  ],
  [
    "DNS failure",
    "fatal: unable to access 'https://github.com/acme/app.git/': Could not resolve host: github.com",
    "network",
  ],
  [
    "fetch first",
    ` ! [rejected]        feature/x -> feature/x (fetch first)
error: failed to push some refs to 'origin'
hint: Updates were rejected because the remote contains work that you do not`,
    "non-fast-forward",
  ],
  [
    "non-fast-forward",
    " ! [rejected]        feature/x -> feature/x (non-fast-forward)\nerror: failed to push some refs",
    "non-fast-forward",
  ],
  [
    "authentication failed",
    "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/acme/app.git/'",
    "auth",
  ],
  [
    "no terminal for credentials",
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "auth",
  ],
  ["path exists", "fatal: '../app.worktrees/t1' already exists", "path-exists"],
  ["branch exists", "fatal: a branch named 'agent/t1' already exists", "branch-exists"],
  [
    "checked out elsewhere",
    "fatal: 'agent/t1' is already checked out at '/code/app.worktrees/t1'",
    "branch-checked-out",
  ],
  [
    "stale worktree",
    "fatal: '/code/app.worktrees/t1' is a missing but already registered worktree;\nuse 'add -f' to override, or 'prune' or 'remove' to clear",
    "stale-worktree",
  ],
  ["anything else", "fatal: bad revision 'nope'", "unknown"],
];

describe("classifyGitError", () => {
  it.each(SAMPLES)("classifies %s", (_, stderr, kind) => {
    expect(classifyGitError(stderr)).toBe(kind);
  });
});

describe("lockPath and refName", () => {
  it("reads POSIX and Windows lock paths", () => {
    expect(lockPath(INDEX_LOCK)).toBe("/repo/.git/index.lock");
    expect(lockPath(REF_LOCK)).toBe("C:/Code/app/.git/refs/heads/agent/t1.lock");
    expect(lockPath("fatal: bad revision")).toBeUndefined();
  });

  it("reads the ref a ref error names", () => {
    expect(refName(REF_LOCK)).toBe("refs/heads/agent/t1");
  });
});

describe("describeGitError", () => {
  const error = (stderr: string, args = ["push"]) => new GitError(args, stderr, 128);

  it("explains each kind, followed by git's first line", () => {
    expect(describeGitError(error(SAMPLES[7]![1]))).toBe(
      "Git could not authenticate to the remote. Set up git credentials (credential manager or SSH key) for it; this is not the blackwall token. (remote: Invalid username or token.)",
    );
    expect(describeGitError(error(SAMPLES[2]![1]))).toMatch(
      /^Git could not update refs\/heads\/main: it moved while blackwall was working/,
    );
    expect(describeGitError(error(SAMPLES[6]![1]))).toBe(
      "The remote branch has commits this branch does not. Pull or rebase it, then finish again. (! [rejected]        feature/x -> feature/x (non-fast-forward))",
    );
    expect(describeGitError(error(SAMPLES[4]![1]))).toMatch(
      /^Could not reach the remote\. Check the connection and retry\. \(fatal: unable to access/,
    );
    expect(describeGitError(error(SAMPLES[11]![1]))).toMatch(
      /^The branch is checked out in another worktree \(\/code\/app\.worktrees\/t1\)\./,
    );
  });

  it("says whether a lock was held or removed", () => {
    const held = error(INDEX_LOCK, ["commit"]);
    expect(describeGitError(held)).toMatch(
      /^Another git process holds \/repo\/\.git\/index\.lock\. Blackwall removes it automatically once it is older than 2 minutes/,
    );
    const removed = error(INDEX_LOCK, ["rebase"]);
    removed.staleLockRemoved = true;
    expect(describeGitError(removed)).toBe(
      "Removed a stale git lock /repo/.git/index.lock left by an earlier git process. Retry. (fatal: Unable to create '/repo/.git/index.lock': File exists.)",
    );
  });

  it("keeps the message for other kinds", () => {
    const unknown = error("fatal: bad revision 'nope'", ["rev-parse", "nope"]);
    expect(describeGitError(unknown)).toBe(unknown.message);
  });

  it("strips credentials from remote URLs", () => {
    const leaky = error(
      "fatal: unable to access 'https://user:ghp_secret@github.com/acme/app.git/': Could not resolve host: github.com",
    );
    expect(describeGitError(leaky)).not.toContain("ghp_secret");
    expect(describeGitError(leaky)).toContain("https://github.com/acme/app.git/");
    const unknown = error("fatal: 'https://x:tok@host/r' bad", ["fetch"]);
    expect(describeGitError(unknown)).not.toContain("tok@");
  });
});
