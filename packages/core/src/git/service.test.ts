import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchForTask, worktreePathFor } from "./branches.js";
import { hookOutput } from "./errors.js";
import {
  GitError,
  ProtectedBranchError,
  createGitService,
  runGit,
  sameSnapshot,
  type GitService,
} from "./service.js";

let root: string;
let repo: string;
let origin: string;
let service: GitService;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function write(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
}

function commit(dir: string, file: string, content: string, message = `edit ${file}`): string {
  write(dir, file, content);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function log(dir: string, ref = "HEAD"): string[] {
  return git(dir, "log", "--format=%s", ref).split("\n");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-git-")));
  origin = join(root, "origin.git");
  repo = join(root, "app");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "remote", "add", "origin", origin);
  commit(repo, "README.md", "hello\n", "initial");
  git(repo, "push", "--quiet", "origin", "main");
  service = createGitService();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createWorktree", () => {
  it("creates a Jira feature branch from main next to the repo", async () => {
    const branch = branchForTask({
      kind: "jira-issue",
      key: "ABC-1",
      title: "Add login",
      issueType: "Story",
    });
    const path = worktreePathFor(repo, "t1");
    const wt = await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch,
      checkout: { kind: "new" },
    });

    expect(path).toBe(join(root, "app.worktrees", "t1"));
    expect(wt).toEqual({
      path,
      branch: "feature/abc-1-add-login",
      baseSha: git(repo, "rev-parse", "main"),
    });
    expect(git(path, "branch", "--show-current")).toBe("feature/abc-1-add-login");
  });

  it("creates a Jira fix branch for bugs", async () => {
    const branch = branchForTask({
      kind: "jira-issue",
      key: "ABC-2",
      title: "Crash",
      issueType: "Bug",
    });
    const path = worktreePathFor(repo, "t2");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch,
      checkout: { kind: "new" },
    });
    expect(git(path, "branch", "--show-current")).toBe("fix/abc-2-crash");
  });

  it("creates the free-text agent/<task-id> branch", async () => {
    const branch = branchForTask({ kind: "free-text", taskId: "t3" });
    const path = worktreePathFor(repo, "t3");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch,
      checkout: { kind: "new" },
    });
    expect(git(path, "branch", "--show-current")).toBe("agent/t3");
  });

  it("checks out a PR head branch that only exists on the remote, after fetching", async () => {
    // Someone else pushes the PR branch.
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.com");
    git(other, "switch", "--quiet", "-c", "feature/pr-branch");
    const prHead = commit(other, "pr.txt", "pr\n");
    git(other, "push", "--quiet", "origin", "feature/pr-branch");

    const branch = branchForTask({ kind: "github-pr", headBranch: "feature/pr-branch" });
    const path = worktreePathFor(repo, "t4");
    const wt = await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch,
      checkout: { kind: "existing", fetch: true },
    });

    expect(wt.baseSha).toBe(prHead);
    expect(git(path, "branch", "--show-current")).toBe("feature/pr-branch");
    expect(git(path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/pr-branch");
  });

  /** Pushes `stack-base` and `feature/stacked` built on it from another clone. */
  function pushStack() {
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.com");
    git(other, "switch", "--quiet", "-c", "stack-base");
    const baseTip = commit(other, "base.txt", "base\n");
    git(other, "push", "--quiet", "origin", "stack-base");
    git(other, "switch", "--quiet", "-c", "feature/stacked");
    commit(other, "stacked.txt", "stacked\n");
    git(other, "push", "--quiet", "origin", "feature/stacked");
    return { other, baseTip };
  }

  it("fetches a stacked PR's base branch with its head", async () => {
    const { baseTip } = pushStack();
    const path = worktreePathFor(repo, "t4");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "feature/stacked",
      checkout: { kind: "existing", fetch: true, base: "stack-base" },
    });
    expect(git(repo, "rev-parse", "refs/remotes/origin/stack-base")).toBe(baseTip);
    expect(await service.mergeBase(path, "origin/stack-base")).toBe(baseTip);
  });

  it("still creates the worktree when the base branch cannot be fetched", async () => {
    pushStack();
    const path = worktreePathFor(repo, "t4");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "feature/stacked",
      checkout: { kind: "existing", fetch: true, base: "does-not-exist" },
    });
    expect(git(path, "branch", "--show-current")).toBe("feature/stacked");
  });

  it("does not refetch the base branch for an existing worktree", async () => {
    const { other, baseTip } = pushStack();
    const input = {
      repoPath: repo,
      worktreePath: worktreePathFor(repo, "t4"),
      branch: "feature/stacked",
      checkout: { kind: "existing", fetch: true, base: "stack-base" },
    } as const;
    await service.createWorktree(input);
    git(other, "switch", "--quiet", "stack-base");
    commit(other, "later.txt", "later\n");
    git(other, "push", "--quiet", "origin", "stack-base");

    await service.createWorktree(input);
    expect(git(repo, "rev-parse", "refs/remotes/origin/stack-base")).toBe(baseTip);
  });

  it("checks out an existing local PR branch", async () => {
    git(repo, "branch", "feature/local");
    const path = worktreePathFor(repo, "t5");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "feature/local",
      checkout: { kind: "existing" },
    });
    expect(git(path, "branch", "--show-current")).toBe("feature/local");
  });

  it("returns an existing worktree on the same branch and rejects another branch", async () => {
    const path = worktreePathFor(repo, "t6");
    const input = {
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t6",
      checkout: { kind: "new" },
    } as const;
    const first = await service.createWorktree(input);
    commit(path, "a.txt", "a\n");
    const again = await service.createWorktree(input);
    expect(again.baseSha).toBe(git(path, "rev-parse", "HEAD"));
    expect(again.baseSha).not.toBe(first.baseSha);
    await expect(
      service.createWorktree({ ...input, branch: "agent/other" }),
    ).rejects.toBeInstanceOf(GitError);
  });

  describe("after an earlier attempt failed", () => {
    const input = (id: string) =>
      ({
        repoPath: repo,
        worktreePath: worktreePathFor(repo, id),
        branch: `agent/${id}`,
        checkout: { kind: "new" },
      }) as const;

    it("reuses a branch the earlier attempt created", async () => {
      git(repo, "branch", "agent/t7");
      const head = commit(repo, "later.txt", "later\n");
      const wt = await service.createWorktree(input("t7"));
      expect(git(wt.path, "branch", "--show-current")).toBe("agent/t7");
      expect(wt.baseSha).not.toBe(head);
    });

    it("prunes a registration whose folder is gone", async () => {
      const first = await service.createWorktree(input("t8"));
      rmSync(first.path, { recursive: true, force: true });
      const again = await service.createWorktree(input("t8"));
      expect(git(again.path, "branch", "--show-current")).toBe("agent/t8");
    });

    it("uses an empty leftover folder and refuses one with files", async () => {
      mkdirSync(worktreePathFor(repo, "t9"), { recursive: true });
      const wt = await service.createWorktree(input("t9"));
      expect(git(wt.path, "branch", "--show-current")).toBe("agent/t9");

      const busy = worktreePathFor(repo, "t10");
      mkdirSync(busy, { recursive: true });
      write(busy, "keep.txt", "mine\n");
      const error = await service.createWorktree(input("t10")).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).kind).toBe("path-exists");
      expect(readFileSync(join(busy, "keep.txt"), "utf8")).toBe("mine\n");
    });
  });
});

describe("renameBranch and branchExists", () => {
  it("renames the branch checked out in a worktree", async () => {
    const path = worktreePathFor(repo, "t1");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t1",
      checkout: { kind: "new" },
    });
    await service.renameBranch(path, "agent/t1", "feat/fix-login");
    expect(git(path, "symbolic-ref", "--short", "HEAD")).toBe("feat/fix-login");
    expect(() => git(repo, "rev-parse", "--verify", "refs/heads/agent/t1")).toThrow();
  });

  it("refuses to rename from or to main", async () => {
    await expect(service.renameBranch(repo, "main", "feat/x")).rejects.toThrow(
      ProtectedBranchError,
    );
    await expect(service.renameBranch(repo, "feat/x", "main")).rejects.toThrow(
      ProtectedBranchError,
    );
  });

  it("finds local and remote-tracking branches without fetching", async () => {
    git(repo, "branch", "feat/local");
    git(repo, "update-ref", "refs/remotes/origin/feat/remote", "HEAD");
    expect(await service.branchExists(repo, "feat/local")).toBe(true);
    expect(await service.branchExists(repo, "feat/remote")).toBe(true);
    expect(await service.branchExists(repo, "feat/none")).toBe(false);
  });
});

describe("git lock files", () => {
  const indexLock = () => join(repo, ".git", "index.lock");

  function lock(path: string, ageMs: number): void {
    writeFileSync(path, "");
    const then = new Date(Date.now() - ageMs);
    utimesSync(path, then, then);
  }

  it("removes a stale lock and commits", async () => {
    lock(indexLock(), 5 * 60_000);
    write(repo, "a.txt", "a\n");
    expect(await service.commitAll(repo, "after a crash")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(indexLock())).toBe(false);
  });

  it("waits for a fresh lock another process releases", async () => {
    lock(indexLock(), 0);
    setTimeout(() => rmSync(indexLock(), { force: true }), 300);
    write(repo, "a.txt", "a\n");
    expect(await service.commitAll(repo, "after the other process")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("leaves a fresh lock that is never released", async () => {
    lock(indexLock(), 0);
    write(repo, "a.txt", "a\n");
    const error = (await service.commitAll(repo, "blocked").catch((e: unknown) => e)) as GitError;
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("lock");
    expect(error.staleLockRemoved).toBe(false);
    expect(existsSync(indexLock())).toBe(true);
  });

  it("removes a stale lock in a linked worktree", async () => {
    const wt = await service.createWorktree({
      repoPath: repo,
      worktreePath: worktreePathFor(repo, "t1"),
      branch: "agent/t1",
      checkout: { kind: "new" },
    });
    const wtLock = resolve(wt.path, git(wt.path, "rev-parse", "--git-path", "index.lock"));
    expect(wtLock).toContain(join(".git", "worktrees"));
    lock(wtLock, 5 * 60_000);
    write(wt.path, "a.txt", "a\n");
    expect(await service.commitAll(wt.path, "after a crash")).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(wtLock)).toBe(false);
  });

  it("removes a stale lock but does not retry a rebase", async () => {
    git(repo, "switch", "--quiet", "-c", "side");
    const sideHead = commit(repo, "side.txt", "side\n");
    git(repo, "switch", "--quiet", "main");
    commit(repo, "main.txt", "main\n");
    git(repo, "switch", "--quiet", "side");
    lock(indexLock(), 5 * 60_000);
    const error = (await runGit(repo, ["rebase", "--quiet", "main"]).catch(
      (e: unknown) => e,
    )) as GitError;
    expect(error).toBeInstanceOf(GitError);
    expect(error.kind).toBe("lock");
    expect(error.staleLockRemoved).toBe(true);
    expect(existsSync(indexLock())).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(sideHead);
  });

  it("keeps a stale lock while another git command of its own runs", async () => {
    const slow = runGit(repo, ["-c", "alias.wait=!sleep 5", "wait"]);
    lock(indexLock(), 5 * 60_000);
    write(repo, "a.txt", "a\n");
    const error = (await service.commitAll(repo, "blocked").catch((e: unknown) => e)) as GitError;
    expect(error.kind).toBe("lock");
    expect(error.staleLockRemoved).toBe(false);
    expect(existsSync(indexLock())).toBe(true);
    await slow;
  }, 15_000);
});

describe("commits, squash and diff", () => {
  it("commits each round, diffs per round and squashes at finish", async () => {
    const path = worktreePathFor(repo, "t1");
    const wt = await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t1",
      checkout: { kind: "new" },
    });

    expect(await service.commitAll(path, "nothing")).toBeNull();
    expect(await service.stagedDiff(path)).toBe("");

    write(path, "a.txt", "one\n");
    // New files count: the diff is what the commit will hold.
    expect(await service.stagedDiff(path)).toContain("+one");
    const round1 = await service.commitAll(path, "ABC-1 round 1");
    write(path, "a.txt", "two\n");
    write(path, "b.txt", "new\n");
    const round2 = await service.commitAll(path, "ABC-1 round 2");
    expect(round1).toMatch(/^[0-9a-f]{40}$/);
    expect(round2).toBe(git(path, "rev-parse", "HEAD"));
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(log(path)).toEqual(["ABC-1 round 2", "ABC-1 round 1", "initial"]);

    const roundDiff = await service.diff(path, round1!, round2!);
    expect(roundDiff).toContain("-one");
    expect(roundDiff).toContain("+two");
    expect(roundDiff).toContain("b/b.txt");
    expect(await service.diff(path, wt.baseSha)).toContain("+two");
    expect(await service.mergeBase(path, "main")).toBe(wt.baseSha);

    const squashed = await service.squash(path, wt.baseSha, "ABC-1 everything");
    expect(squashed).toBe(git(path, "rev-parse", "HEAD"));
    expect(log(path)).toEqual(["ABC-1 everything", "initial"]);
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("two\n");
    expect(await service.squash(path, squashed!, "noop")).toBeNull();
  });
});

describe("commit hooks", () => {
  /** Installs a hook in the repo's hooks folder, shared by its worktrees. */
  function hook(name: string, script: string): void {
    const dir = resolve(repo, git(repo, "rev-parse", "--git-path", "hooks"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }

  const CONVENTIONAL_ONLY = `grep -qE '^[a-z]+(\\([^)]*\\))?: ' "$1" || { echo "subject must be conventional" >&2; exit 1; }`;

  async function worktree(): Promise<string> {
    const path = worktreePathFor(repo, "t1");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t1",
      checkout: { kind: "new" },
    });
    return path;
  }

  it("names the commit-msg hook that rejected a message", async () => {
    hook("commit-msg", CONVENTIONAL_ONLY);
    write(repo, "a.txt", "one\n");
    const error = await service.commitAll(repo, "Add login").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ kind: "hook-rejected", hook: "commit-msg" });
    expect(hookOutput(error as GitError)).toContain("subject must be conventional");
    expect(log(repo)).toEqual(["initial"]);

    expect(await service.commitAll(repo, "feat: add login")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(log(repo)).toEqual(["feat: add login", "initial"]);
  });

  it("names the pre-commit hook, with what it printed to stdout", async () => {
    hook("pre-commit", 'echo "lint: 1 problem in a.txt"\nexit 1');
    write(repo, "a.txt", "one\n");
    const error = await service.commitAll(repo, "feat: a").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "hook-rejected", hook: "pre-commit" });
    expect(hookOutput(error as GitError)).toContain("lint: 1 problem in a.txt");
  });

  it("restores the branch when a squash is rejected", async () => {
    const path = await worktree();
    const base = git(path, "rev-parse", "HEAD");
    commit(path, "a.txt", "one\n", "feat: one");
    const head = commit(path, "b.txt", "two\n", "feat: two");
    hook("commit-msg", CONVENTIONAL_ONLY);

    const error = await service.squash(path, base, "Everything").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "hook-rejected", hook: "commit-msg" });
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(git(path, "status", "--porcelain")).toBe("");

    await service.squash(path, base, "feat: everything");
    expect(log(path)).toEqual(["feat: everything", "initial"]);
  });

  it("leaves commits without hooks alone", async () => {
    write(repo, "a.txt", "one\n");
    expect(await service.commitAll(repo, "Anything goes")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(log(repo)).toEqual(["Anything goes", "initial"]);
  });
});

describe("finishIntoMain", () => {
  async function freeTextTask(id: string) {
    const path = worktreePathFor(repo, id);
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: `agent/${id}`,
      checkout: { kind: "new" },
    });
    return path;
  }

  it("rebases onto main and fast-forwards main when it is checked out", async () => {
    const path = await freeTextTask("t1");
    commit(path, "feature.txt", "feature\n", "task work");
    commit(repo, "other.txt", "other\n", "main moved");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t1",
    });

    expect(result).toEqual({
      status: "merged",
      sha: git(path, "rev-parse", "HEAD"),
      resolved: [],
    });
    expect(git(repo, "rev-parse", "main")).toBe(git(path, "rev-parse", "HEAD"));
    expect(log(repo)).toEqual(["task work", "main moved", "initial"]);
    expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
    // Local only: the remote main is untouched.
    expect(git(origin, "log", "--format=%s", "main")).toBe("initial");
  });

  it("fast-forwards the main ref when main is not checked out", async () => {
    const path = await freeTextTask("t2");
    commit(path, "feature.txt", "feature\n", "task work");
    git(repo, "switch", "--quiet", "-c", "elsewhere");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t2",
    });

    expect(result.status).toBe("merged");
    expect(log(repo, "main")).toEqual(["task work", "initial"]);
  });

  it("stops on a rebase conflict, reports the files and changes nothing", async () => {
    const path = await freeTextTask("t3");
    const taskHead = commit(path, "README.md", "from task\n", "task edit");
    const mainHead = commit(repo, "README.md", "from main\n", "main edit");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t3",
    });

    expect(result).toEqual({ status: "conflict", files: ["README.md"] });
    expect(git(path, "rev-parse", "HEAD")).toBe(taskHead);
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
  });

  function rebasing(path: string): boolean {
    return ["rebase-merge", "rebase-apply"].some((dir) =>
      existsSync(resolve(path, git(path, "rev-parse", "--git-path", dir))),
    );
  }

  it("has the resolver resolve a conflict, continues the rebase and fast-forwards main", async () => {
    const path = await freeTextTask("t4");
    commit(path, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");
    const calls: string[][] = [];

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t4",
      resolve: async ({ files }) => {
        calls.push(files);
        expect(readFileSync(join(path, "README.md"), "utf8")).toContain("<<<<<<< ");
        write(path, "README.md", "from main\nfrom task\n");
      },
    });

    expect(calls).toEqual([["README.md"]]);
    expect(result).toEqual({
      status: "merged",
      sha: git(path, "rev-parse", "HEAD"),
      resolved: ["README.md"],
    });
    expect(git(repo, "rev-parse", "main")).toBe(git(path, "rev-parse", "HEAD"));
    expect(log(repo)).toEqual(["task edit", "main edit", "initial"]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("from main\nfrom task\n");
    expect(rebasing(path)).toBe(false);
  });

  it("never opens an editor, even with GIT_EDITOR set", async () => {
    const path = await freeTextTask("t5");
    commit(path, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");
    const saved = process.env.GIT_EDITOR;
    process.env.GIT_EDITOR = "false";
    try {
      const result = await service.finishIntoMain({
        repoPath: repo,
        worktreePath: path,
        branch: "agent/t5",
        resolve: async () => write(path, "README.md", "both\n"),
      });
      expect(result.status).toBe("merged");
    } finally {
      if (saved === undefined) delete process.env.GIT_EDITOR;
      else process.env.GIT_EDITOR = saved;
    }
  });

  it("accepts a Markdown setext underline in the resolved content", async () => {
    const path = await freeTextTask("t6");
    commit(path, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t6",
      resolve: async () => write(path, "README.md", "Title\n=======\n\nbody\n"),
    });

    expect(result.status).toBe("merged");
  });

  it.each([
    ["checked out", false],
    ["not checked out", true],
  ])("reports a rebase the resolver quit as unfinished, with main %s", async (_, elsewhere) => {
    const path = await freeTextTask("t4b");
    const taskHead = commit(path, "README.md", "from task\n", "task edit");
    const mainHead = commit(repo, "README.md", "from main\n", "main edit");
    if (elsewhere) git(repo, "switch", "--quiet", "-c", "elsewhere");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t4b",
      resolve: async () => {
        write(path, "README.md", "both\n");
        // Leaves HEAD detached at main and the branch where it was.
        git(path, "rebase", "--quit");
      },
    });

    expect(result).toEqual({
      status: "conflict",
      files: ["README.md"],
      unresolved: "the rebase was left unfinished",
    });
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
    expect(git(path, "branch", "--show-current")).toBe("agent/t4b");
    expect(git(path, "rev-parse", "HEAD")).toBe(taskHead);
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(rebasing(path)).toBe(false);
  });

  it("checks the branch out again when a quit rebase left HEAD detached", async () => {
    const path = await freeTextTask("t4c");
    commit(path, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");
    expect(() => git(path, "rebase", "--quiet", "main")).toThrow();
    git(path, "rebase", "--quit");
    expect(git(path, "branch", "--show-current")).toBe("");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t4c",
      resolve: async () => write(path, "README.md", "both\n"),
    });

    expect(result).toMatchObject({ status: "merged", resolved: ["README.md"] });
    expect(git(path, "branch", "--show-current")).toBe("agent/t4c");
    expect(git(repo, "rev-parse", "main")).toBe(git(path, "rev-parse", "agent/t4c"));
    expect(log(repo, "main")).toEqual(["task edit", "main edit", "initial"]);
  });

  it("resolves each conflicting commit in turn", async () => {
    const path = await freeTextTask("t7");
    commit(path, "README.md", "task one\n", "task one");
    commit(path, "README.md", "task two\n", "task two");
    commit(repo, "README.md", "from main\n", "main edit");
    let calls = 0;

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t7",
      resolve: async () => {
        calls += 1;
        write(path, "README.md", `resolved ${calls}\n`);
      },
    });

    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "merged", resolved: ["README.md"] });
    expect(log(repo)).toEqual(["task two", "task one", "main edit", "initial"]);
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("resolved 2\n");
  });

  it("lets the resolver delete a file main deleted", async () => {
    commit(repo, "gone.txt", "base\n", "add gone");
    const path = await freeTextTask("t8");
    commit(path, "gone.txt", "task change\n", "task edit");
    git(repo, "rm", "--quiet", "gone.txt");
    git(repo, "commit", "--quiet", "-m", "main delete");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t8",
      resolve: async ({ files }) => {
        expect(files).toEqual(["gone.txt"]);
        rmSync(join(path, "gone.txt"));
      },
    });

    expect(result).toMatchObject({ status: "merged", resolved: ["gone.txt"] });
    expect(existsSync(join(repo, "gone.txt"))).toBe(false);
    expect(git(repo, "rev-parse", "main")).toBe(git(path, "rev-parse", "HEAD"));
  });

  it("lets the resolver keep a file main deleted", async () => {
    commit(repo, "kept.txt", "base\n", "add kept");
    const path = await freeTextTask("t9");
    commit(path, "kept.txt", "task change\n", "task edit");
    git(repo, "rm", "--quiet", "kept.txt");
    git(repo, "commit", "--quiet", "-m", "main delete");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t9",
      resolve: async () => write(path, "kept.txt", "task change\n"),
    });

    expect(result.status).toBe("merged");
    expect(readFileSync(join(repo, "kept.txt"), "utf8")).toBe("task change\n");
  });

  it("aborts when the resolver leaves conflict markers", async () => {
    const path = await freeTextTask("t10");
    const taskHead = commit(path, "README.md", "from task\n", "task edit");
    const mainHead = commit(repo, "README.md", "from main\n", "main edit");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t10",
      resolve: async () => undefined,
    });

    expect(result).toEqual({
      status: "conflict",
      files: ["README.md"],
      unresolved: "conflict markers left in README.md",
    });
    expect(git(path, "rev-parse", "HEAD")).toBe(taskHead);
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
    expect(rebasing(path)).toBe(false);
  });

  it("aborts when the resolver throws", async () => {
    const path = await freeTextTask("t11");
    const taskHead = commit(path, "README.md", "from task\n", "task edit");
    const mainHead = commit(repo, "README.md", "from main\n", "main edit");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t11",
      resolve: () => Promise.reject(new Error("usage limit")),
    });

    expect(result).toEqual({ status: "conflict", files: ["README.md"], unresolved: "usage limit" });
    expect(git(path, "rev-parse", "HEAD")).toBe(taskHead);
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
    expect(rebasing(path)).toBe(false);
  });

  it("aborts a rebase a crash left behind before finishing", async () => {
    const path = await freeTextTask("t12");
    commit(path, "README.md", "from task\n", "task edit");
    commit(repo, "README.md", "from main\n", "main edit");
    expect(() => git(path, "rebase", "--quiet", "main")).toThrow();
    expect(rebasing(path)).toBe(true);

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t12",
      resolve: async () => write(path, "README.md", "both\n"),
    });

    expect(result).toMatchObject({ status: "merged", resolved: ["README.md"] });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("both\n");
  });

  it("refuses to finish the main branch itself", async () => {
    await expect(
      service.finishIntoMain({ repoPath: repo, worktreePath: repo, branch: "main" }),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
  });

  it("finishes into the repo's default branch, leaving main alone", async () => {
    git(repo, "branch", "develop");
    const path = worktreePathFor(repo, "t20");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t20",
      checkout: { kind: "new", base: "develop" },
    });
    commit(path, "feature.txt", "feature\n", "task work");
    const mainHead = commit(repo, "other.txt", "other\n", "main moved");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t20",
      into: "develop",
    });

    expect(result).toMatchObject({ status: "merged", sha: git(path, "rev-parse", "HEAD") });
    expect(git(repo, "rev-parse", "develop")).toBe(git(path, "rev-parse", "HEAD"));
    expect(git(repo, "rev-parse", "main")).toBe(mainHead);
    expect(git(repo, "log", "--format=%s", "develop")).not.toContain("main moved");
  });

  it("refuses to finish the default branch into itself", async () => {
    git(repo, "branch", "develop");
    await expect(
      service.finishIntoMain({
        repoPath: repo,
        worktreePath: repo,
        branch: "develop",
        into: "develop",
      }),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
  });
});

describe("push", () => {
  it("pushes the task branch with upstream", async () => {
    const path = worktreePathFor(repo, "t1");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "fix/abc-1-x",
      checkout: { kind: "new" },
    });
    const head = commit(path, "x.txt", "x\n");

    await service.push(path, "fix/abc-1-x");

    expect(git(origin, "rev-parse", "fix/abc-1-x")).toBe(head);
    expect(git(path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/fix/abc-1-x");
  });

  describe("when the remote branch moved on", () => {
    const branch = "feature/moved";
    let path: string;
    let other: string;

    /** Pushes the task branch, then another clone adds `file` to it on the remote. */
    beforeEach(async () => {
      path = worktreePathFor(repo, "t2");
      await service.createWorktree({
        repoPath: repo,
        worktreePath: path,
        branch,
        checkout: { kind: "new" },
      });
      commit(path, "mine.txt", "mine\n", "first round");
      await service.push(path, branch);
      other = join(root, "other");
      git(root, "clone", "--quiet", "--branch", branch, origin, other);
      git(other, "config", "user.name", "Other");
      git(other, "config", "user.email", "other@example.com");
    });

    it("rebases onto the remote branch and pushes, with integrate", async () => {
      commit(other, "theirs.txt", "theirs\n", "their commit");
      git(other, "push", "--quiet", "origin", branch);
      commit(path, "mine.txt", "mine 2\n", "second round");

      const result = await service.push(path, branch, undefined, { integrate: {} });

      expect(result).toEqual({ status: "pushed", integrated: true, resolved: [] });
      expect(log(origin, branch)).toEqual([
        "second round",
        "their commit",
        "first round",
        "initial",
      ]);
      expect(git(path, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", branch));
    });

    it("has the resolver resolve a conflict", async () => {
      commit(other, "mine.txt", "theirs\n", "their edit");
      git(other, "push", "--quiet", "origin", branch);
      commit(path, "mine.txt", "mine 2\n", "second round");

      const result = await service.push(path, branch, undefined, {
        integrate: { resolve: async () => write(path, "mine.txt", "both\n") },
      });

      expect(result).toEqual({ status: "pushed", integrated: true, resolved: ["mine.txt"] });
      expect(log(origin, branch)).toEqual(["second round", "their edit", "first round", "initial"]);
      expect(git(origin, "show", `${branch}:mine.txt`)).toBe("both");
    });

    it("reports a conflict the resolver could not resolve and pushes nothing", async () => {
      commit(other, "mine.txt", "theirs\n", "their edit");
      git(other, "push", "--quiet", "origin", branch);
      const remoteHead = git(origin, "rev-parse", branch);
      const localHead = commit(path, "mine.txt", "mine 2\n", "second round");

      const result = await service.push(path, branch, undefined, {
        integrate: { resolve: () => Promise.reject(new Error("usage limit")) },
      });

      expect(result).toEqual({
        status: "conflict",
        files: ["mine.txt"],
        unresolved: "usage limit",
      });
      expect(git(origin, "rev-parse", branch)).toBe(remoteHead);
      expect(git(path, "rev-parse", "HEAD")).toBe(localHead);
      expect(git(path, "status", "--porcelain")).toBe("");
    });

    it("throws the rejection without integrate", async () => {
      commit(other, "theirs.txt", "theirs\n", "their commit");
      git(other, "push", "--quiet", "origin", branch);
      commit(path, "mine.txt", "mine 2\n", "second round");

      const error = (await service.push(path, branch).catch((e: unknown) => e)) as GitError;
      expect(error).toBeInstanceOf(GitError);
      expect(error.kind).toBe("non-fast-forward");
      expect(log(origin, branch)).toEqual(["their commit", "first round", "initial"]);
    });
  });

  it("never pushes main (or the configured main branch)", async () => {
    commit(repo, "local.txt", "local\n");
    const before = git(origin, "rev-parse", "main");

    await expect(service.push(repo, "main")).rejects.toBeInstanceOf(ProtectedBranchError);
    await expect(service.push(repo, "refs/heads/main")).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
    await expect(service.push(repo, "master")).rejects.toBeInstanceOf(ProtectedBranchError);
    git(repo, "branch", "trunk");
    await expect(
      createGitService({ mainBranch: "trunk" }).push(repo, "trunk"),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(git(origin, "rev-parse", "main")).toBe(before);
  });

  it("treats main, master and the configured main branch as protected", () => {
    expect(service.isProtected("main")).toBe(true);
    expect(service.isProtected("refs/heads/main")).toBe(true);
    expect(service.isProtected("master")).toBe(true);
    expect(service.isProtected("feature/x")).toBe(false);
    expect(createGitService({ mainBranch: "trunk" }).isProtected("trunk")).toBe(true);
  });

  it("protects the repo's default branch when one is given", async () => {
    expect(service.isProtected("develop")).toBe(false);
    expect(service.isProtected("develop", "develop")).toBe(true);
    expect(service.isProtected("main", "develop")).toBe(true);
    expect(service.isProtected("master", "develop")).toBe(true);
    git(repo, "branch", "develop");
    await expect(service.push(repo, "develop", "develop")).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
  });
});

/** Another clone pushes a commit per subject to origin's main; returns the new remote tip. */
function originMoves(...subjects: string[]): string {
  const other = join(root, `other-${Math.random().toString(36).slice(2)}`);
  git(root, "clone", "--quiet", origin, other);
  git(other, "config", "user.name", "Other");
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "commit.gpgsign", "false");
  for (const subject of subjects)
    commit(other, `${subject.replace(/\W+/g, "-")}.txt`, `${subject}\n`, subject);
  git(other, "push", "--quiet", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

describe("fetchDefault", () => {
  it("updates origin/main only, leaving local main and the main checkout alone", async () => {
    const path = worktreePathFor(repo, "f1");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/f1",
      checkout: { kind: "new" },
    });
    const localMain = git(repo, "rev-parse", "main");
    const remoteTip = originMoves("origin work");

    await service.fetchDefault(path, "main");

    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(remoteTip);
    expect(git(repo, "rev-parse", "main")).toBe(localMain);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(path, "rev-parse", "HEAD")).toBe(localMain);
  });

  it("throws without a remote", async () => {
    git(repo, "remote", "remove", "origin");
    await expect(service.fetchDefault(repo, "main")).rejects.toBeInstanceOf(GitError);
  });

  it("throws when the remote main was rewritten", async () => {
    originMoves("will be rewritten");
    await service.fetchDefault(repo, "main");
    const other = join(root, "rewriter");
    git(root, "clone", "--quiet", origin, other);
    git(other, "config", "user.name", "Other");
    git(other, "config", "user.email", "other@example.com");
    git(other, "config", "commit.gpgsign", "false");
    git(other, "reset", "--quiet", "--hard", "HEAD~1");
    commit(other, "rewrite.txt", "rewrite\n", "rewritten");
    git(other, "push", "--quiet", "--force", "origin", "main");
    const before = git(repo, "rev-parse", "refs/remotes/origin/main");

    await expect(service.fetchDefault(repo, "main")).rejects.toBeInstanceOf(GitError);
    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(before);
  });
});

describe("fastForwardTo", () => {
  async function task(id: string) {
    const path = worktreePathFor(repo, id);
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: `agent/${id}`,
      checkout: { kind: "new" },
    });
    return path;
  }

  it("moves the branch to origin/main when the remote is ahead, leaving local main", async () => {
    const path = await task("ff1");
    const localMain = git(repo, "rev-parse", "main");
    const remoteTip = originMoves("origin work");
    await service.fetchDefault(path, "main");

    await expect(service.fastForwardTo(path, "agent/ff1", "main")).resolves.toEqual({
      sha: remoteTip,
      onto: "origin/main",
    });
    expect(git(path, "rev-parse", "HEAD")).toBe(remoteTip);
    expect(git(repo, "rev-parse", "main")).toBe(localMain);
  });

  it("uses local main when it is ahead of origin/main", async () => {
    const path = await task("ff2");
    const localTip = commit(repo, "local.txt", "local\n", "local work");

    await expect(service.fastForwardTo(path, "agent/ff2", "main")).resolves.toEqual({
      sha: localTip,
      onto: "main",
    });
  });

  it("uses local main when it diverged from origin/main", async () => {
    const path = await task("ff3");
    originMoves("origin work");
    await service.fetchDefault(path, "main");
    const localTip = commit(repo, "local.txt", "local\n", "local work");

    await expect(service.fastForwardTo(path, "agent/ff3", "main")).resolves.toEqual({
      sha: localTip,
      onto: "main",
    });
  });

  it("uses local main when there is no origin/main", async () => {
    git(repo, "remote", "remove", "origin");
    const path = await task("ff4");
    const localTip = commit(repo, "local.txt", "local\n", "local work");

    await expect(service.fastForwardTo(path, "agent/ff4", "main")).resolves.toEqual({
      sha: localTip,
      onto: "main",
    });
  });

  it("leaves a branch with its own commits alone", async () => {
    const path = await task("ff5");
    const own = commit(path, "own.txt", "own\n", "own work");
    commit(repo, "local.txt", "local\n", "local work");

    await expect(service.fastForwardTo(path, "agent/ff5", "main")).resolves.toBeNull();
    expect(git(path, "rev-parse", "HEAD")).toBe(own);
  });

  it("leaves a dirty worktree alone, keeping its changes", async () => {
    const path = await task("ff6");
    const head = git(path, "rev-parse", "HEAD");
    commit(repo, "local.txt", "local\n", "local work");
    write(path, "README.md", "edited\n");

    await expect(service.fastForwardTo(path, "agent/ff6", "main")).resolves.toBeNull();
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("edited\n");
  });

  it("returns null when the branch is already at the target", async () => {
    const path = await task("ff7");
    await expect(service.fastForwardTo(path, "agent/ff7", "main")).resolves.toBeNull();
  });

  it("ignores a self-ignored .blackwall folder", async () => {
    const path = await task("ff8");
    mkdirSync(join(path, ".blackwall"));
    write(join(path, ".blackwall"), ".gitignore", "*\n");
    write(join(path, ".blackwall"), "notes.md", "notes\n");
    const localTip = commit(repo, "local.txt", "local\n", "local work");

    await expect(service.fastForwardTo(path, "agent/ff8", "main")).resolves.toEqual({
      sha: localTip,
      onto: "main",
    });
  });

  it("refuses a protected branch", async () => {
    await expect(service.fastForwardTo(repo, "main", "main")).rejects.toBeInstanceOf(
      ProtectedBranchError,
    );
  });
});

describe("finishIntoMain after a fast-forward to origin/main", () => {
  async function syncedTask(id: string) {
    const path = worktreePathFor(repo, id);
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: `agent/${id}`,
      checkout: { kind: "new" },
    });
    originMoves("origin one", "origin two");
    await service.fetchDefault(path, "main");
    await service.fastForwardTo(path, `agent/${id}`, "main");
    commit(path, "feature.txt", "feature\n", "task work");
    return path;
  }

  it("moves main through origin's commits and the task's", async () => {
    const path = await syncedTask("o1");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/o1",
    });

    expect(result.status).toBe("merged");
    expect(log(repo, "main")).toEqual(["task work", "origin two", "origin one", "initial"]);
    expect(git(repo, "merge-base", "--is-ancestor", "origin/main", "main")).toBe("");
  });

  it("replays only the task's commits when local main moved meanwhile", async () => {
    const path = await syncedTask("o2");
    commit(repo, "other.txt", "other\n", "another task");

    const result = await service.finishIntoMain({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/o2",
    });

    expect(result.status).toBe("merged");
    // origin's commits are not copied onto the diverged local main.
    expect(log(repo, "main")).toEqual(["task work", "another task", "initial"]);
  });
});

describe("remoteUrl", () => {
  it("reads origin's current URL, or null when there is none", async () => {
    git(repo, "remote", "remove", "origin");
    await expect(service.remoteUrl(repo)).resolves.toBeNull();

    git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
    await expect(service.remoteUrl(repo)).resolves.toBe("https://github.com/acme/app.git");

    git(repo, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    await expect(service.remoteUrl(repo)).resolves.toBe("git@github.com:acme/app.git");
  });
});

describe("removeWorktree", () => {
  it("removes a dirty worktree and its branch, and tolerates a missing folder", async () => {
    const path = worktreePathFor(repo, "t1");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: "agent/t1",
      checkout: { kind: "new" },
    });
    write(path, "dirty.txt", "uncommitted\n");

    await service.removeWorktree({ repoPath: repo, worktreePath: path, deleteBranch: "agent/t1" });

    expect(existsSync(path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("t1");
    expect(git(repo, "branch", "--list", "agent/t1")).toBe("");

    const gone = worktreePathFor(repo, "t2");
    await service.createWorktree({
      repoPath: repo,
      worktreePath: gone,
      branch: "agent/t2",
      checkout: { kind: "new" },
    });
    rmSync(gone, { recursive: true, force: true });
    await service.removeWorktree({ repoPath: repo, worktreePath: gone, deleteBranch: "agent/t2" });
    expect(git(repo, "worktree", "list")).not.toContain("t2");
    expect(git(repo, "branch", "--list", "agent/t2")).toBe("");
  });

  it("refuses to delete main", async () => {
    await expect(
      service.removeWorktree({
        repoPath: repo,
        worktreePath: join(root, "nope"),
        deleteBranch: "main",
      }),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(git(repo, "branch", "--list", "main")).toContain("main");
  });

  it("refuses to delete the repo's default branch", async () => {
    git(repo, "branch", "develop");
    await expect(
      service.removeWorktree({
        repoPath: repo,
        worktreePath: join(root, "nope"),
        deleteBranch: "develop",
        mainBranch: "develop",
      }),
    ).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(git(repo, "branch", "--list", "develop")).toContain("develop");
  });
});

describe("snapshotWorktree and restoreWorktree", () => {
  /** A worktree with a staged, an unstaged and an untracked change on top of two committed files. */
  async function dirty(id: string): Promise<string> {
    const path = worktreePathFor(repo, id);
    await service.createWorktree({
      repoPath: repo,
      worktreePath: path,
      branch: `agent/${id}`,
      checkout: { kind: "new" },
    });
    commit(path, "staged.txt", "one\n", "add staged");
    commit(path, "unstaged.txt", "one\n", "add unstaged");
    write(path, "staged.txt", "two\n");
    git(path, "add", "staged.txt");
    write(path, "unstaged.txt", "two\n");
    write(path, "untracked.txt", "new\n");
    return path;
  }

  /** What a restore must bring back: HEAD, status, both diffs and every file's content. */
  function view(dir: string) {
    const names = git(dir, "ls-files", "--cached", "--others", "--exclude-standard")
      .split("\n")
      .filter(Boolean);
    return {
      head: git(dir, "rev-parse", "HEAD"),
      status: git(dir, "status", "--porcelain"),
      diff: git(dir, "diff"),
      cached: git(dir, "diff", "--cached"),
      files: Object.fromEntries(
        names.map((name) => [
          name,
          existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null,
        ]),
      ),
    };
  }

  it("is stable when nothing changes, and leaves the real index alone", async () => {
    const path = await dirty("s1");
    expect(git(path, "status", "--porcelain")).toBe(
      "M  staged.txt\n M unstaged.txt\n?? untracked.txt",
    );
    const cachedBefore = git(path, "diff", "--cached");
    const stageBefore = git(path, "ls-files", "--stage");

    const first = await service.snapshotWorktree(path);
    const second = await service.snapshotWorktree(path);

    expect(sameSnapshot(first, second)).toBe(true);
    expect(first.head).toBe(git(path, "rev-parse", "HEAD"));
    expect(first.worktree).not.toBe(first.index);
    expect(git(path, "diff", "--cached")).toBe(cachedBefore);
    expect(git(path, "ls-files", "--stage")).toBe(stageBefore);
  });

  it.each([
    ["edits the staged file further", (path: string) => write(path, "staged.txt", "three\n")],
    ["adds a new untracked file", (path: string) => write(path, "added.txt", "added\n")],
    ["deletes a tracked file", (path: string) => rmSync(join(path, "unstaged.txt"))],
    ["makes a new commit", (path: string) => git(path, "commit", "--quiet", "-am", "feat: more")],
  ])("notices when the worktree %s, and restores the exact state", async (_, change) => {
    const path = await dirty("s2");
    const snapshot = await service.snapshotWorktree(path);
    const before = view(path);

    await change(path);
    expect(sameSnapshot(await service.snapshotWorktree(path), snapshot)).toBe(false);

    await service.restoreWorktree(path, snapshot);
    expect(view(path)).toEqual(before);
    expect(await service.snapshotWorktree(path)).toEqual(snapshot);
  });

  it("removes a file added after the snapshot", async () => {
    const path = await dirty("s3");
    const snapshot = await service.snapshotWorktree(path);

    write(path, "added.txt", "added\n");
    git(path, "add", "added.txt");
    await service.restoreWorktree(path, snapshot);

    expect(existsSync(join(path, "added.txt"))).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe(
      "M  staged.txt\n M unstaged.txt\n?? untracked.txt",
    );
  });
});
