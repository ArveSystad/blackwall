import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchForTask, worktreePathFor } from "./branches.js";
import { GitError, ProtectedBranchError, createGitService, type GitService } from "./service.js";

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
});
