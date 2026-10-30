import type { Repo, Task } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import {
  GitError,
  type CreateWorktreeInput,
  type GitService,
  type RemoveWorktreeInput,
} from "../git/service.js";
import { worktreePathFor } from "../git/branches.js";
import {
  createInRepoClaims,
  createPrHeadSync,
  createWorkspacePreparer,
  createWorkspaceRemover,
  createWorkspaceSyncer,
} from "./workspace.js";

const repo = { id: "r1", path: "/code/app", name: "app", defaultBranch: "main" } as Repo;

function preparer(
  baseBranchFor?: (task: Task) => Promise<string | undefined>,
  forRepo: Repo = repo,
) {
  const createWorktree = vi.fn(async (input: CreateWorktreeInput) => ({
    path: input.worktreePath,
    branch: input.branch,
    baseSha: "abc",
  }));
  const prepare = createWorkspacePreparer({
    git: { createWorktree, switchBranch: vi.fn() },
    repos: { get: (id) => (id === forRepo.id ? forRepo : undefined) },
    tasks: { list: () => [] },
    claims: createInRepoClaims(),
    ...(baseBranchFor ? { baseBranchFor } : {}),
  });
  return { prepare, createWorktree };
}

const task = (patch: Partial<Task>) =>
  ({
    id: "t1",
    repoId: "r1",
    branch: null,
    baseBranch: null,
    worktreePath: null,
    ...patch,
  }) as Task;

describe("createWorkspacePreparer", () => {
  it("creates agent/<task-id> next to the repo for free-text tasks", async () => {
    const { prepare, createWorktree } = preparer();
    const ws = await prepare(task({ origin: { kind: "free-text" } }));
    expect(ws).toEqual({
      branch: "agent/t1",
      worktreePath: worktreePathFor("/code/app", "t1"),
      baseBranch: null,
    });
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "agent/t1", checkout: { kind: "new", base: "main" } }),
    );
  });

  it("forks new branches from the repo's default branch", async () => {
    const { prepare, createWorktree } = preparer(undefined, { ...repo, defaultBranch: "develop" });
    const origins: Task["origin"][] = [
      { kind: "free-text" },
      { kind: "jira-issue", key: "ABC-1", connectionId: null },
      {
        kind: "github-issue",
        url: "https://github.com/acme/app/issues/7",
        owner: "acme",
        repo: "app",
        number: 7,
        connectionId: null,
      },
    ];
    for (const origin of origins) {
      await prepare(task({ origin, branch: "feature/x" }));
      expect(createWorktree).toHaveBeenLastCalledWith(
        expect.objectContaining({ checkout: { kind: "new", base: "develop" } }),
      );
    }
  });

  it("checks out the PR head branch and refuses an unknown branch", async () => {
    const { prepare, createWorktree } = preparer();
    const origin = {
      kind: "github-pr" as const,
      url: "https://github.com/acme/app/pull/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    };
    await prepare(task({ origin, branch: "fix-login" }));
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix-login", checkout: { kind: "existing", fetch: true } }),
    );
    await expect(prepare(task({ origin }))).rejects.toThrow(/branch is not known/);
  });

  const prOrigin = {
    kind: "github-pr" as const,
    url: "https://github.com/acme/app/pull/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };

  it("fetches and records a PR task's base branch from baseBranchFor", async () => {
    const baseBranchFor = vi.fn(async () => "feature/a");
    const { prepare, createWorktree } = preparer(baseBranchFor);
    const ws = await prepare(task({ origin: prOrigin, branch: "feature/b" }));
    expect(ws).toEqual({
      branch: "feature/b",
      worktreePath: worktreePathFor("/code/app", "t1"),
      baseBranch: "feature/a",
    });
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "feature/b",
        checkout: { kind: "existing", fetch: true, base: "feature/a" },
      }),
    );
  });

  it("leaves the base out when baseBranchFor does not know it", async () => {
    const { prepare, createWorktree } = preparer(async () => undefined);
    const ws = await prepare(task({ origin: prOrigin, branch: "feature/b" }));
    expect(ws.baseBranch).toBeNull();
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ checkout: { kind: "existing", fetch: true } }),
    );
  });

  it("does not ask baseBranchFor again when the PR task has a base branch", async () => {
    const baseBranchFor = vi.fn(async () => "main");
    const { prepare, createWorktree } = preparer(baseBranchFor);
    const ws = await prepare(
      task({ origin: prOrigin, branch: "feature/b", baseBranch: "feature/a" }),
    );
    expect(ws.baseBranch).toBe("feature/a");
    expect(baseBranchFor).not.toHaveBeenCalled();
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ checkout: { kind: "existing", fetch: true, base: "feature/a" } }),
    );
  });

  it("never asks baseBranchFor for free-text, Jira or issue tasks", async () => {
    const baseBranchFor = vi.fn(async () => "main");
    const { prepare } = preparer(baseBranchFor);
    const origins: Task["origin"][] = [
      { kind: "free-text" },
      { kind: "jira-issue", key: "ABC-1", connectionId: null },
      { ...prOrigin, kind: "github-issue", url: "https://github.com/acme/app/issues/7" },
    ];
    for (const origin of origins) {
      const ws = await prepare(task({ origin, branch: "feature/x" }));
      expect(ws.baseBranch).toBeNull();
    }
    expect(baseBranchFor).not.toHaveBeenCalled();
  });

  it("asks branchFor for a Jira task's new branch", async () => {
    const createWorktree = vi.fn(async (input: CreateWorktreeInput) => ({
      path: input.worktreePath,
      branch: input.branch,
      baseSha: "abc",
    }));
    const branchFor = vi.fn(async () => "feature/abc-1-export");
    const prepare = createWorkspacePreparer({
      git: { createWorktree, switchBranch: vi.fn() },
      repos: { get: () => repo },
      tasks: { list: () => [] },
      claims: createInRepoClaims(),
      branchFor,
    });
    const ws = await prepare(
      task({ origin: { kind: "jira-issue", key: "ABC-1", connectionId: null } }),
    );
    expect(ws.branch).toBe("feature/abc-1-export");
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "feature/abc-1-export",
        checkout: { kind: "new", base: "main" },
      }),
    );
  });

  it("asks branchFor for a GitHub issue task's new branch", async () => {
    const createWorktree = vi.fn(async (input: CreateWorktreeInput) => ({
      path: input.worktreePath,
      branch: input.branch,
      baseSha: "abc",
    }));
    const branchFor = vi.fn(async () => "fix/7-export-drops-a-row");
    const prepare = createWorkspacePreparer({
      git: { createWorktree, switchBranch: vi.fn() },
      repos: { get: () => repo },
      tasks: { list: () => [] },
      claims: createInRepoClaims(),
      branchFor,
    });
    const origin = {
      kind: "github-issue" as const,
      url: "https://github.com/acme/app/issues/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    };
    const ws = await prepare(task({ origin }));
    expect(ws.branch).toBe("fix/7-export-drops-a-row");
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "fix/7-export-drops-a-row",
        checkout: { kind: "new", base: "main" },
      }),
    );
  });
});

describe("createPrHeadSync", () => {
  function prHead(forRepo: Repo = repo) {
    const fetchBranch = vi.fn<GitService["fetchBranch"]>(async () => "sha-remote");
    const moveBranchTo = vi.fn<GitService["moveBranchTo"]>(async () => true);
    const sync = createPrHeadSync({
      git: { fetchBranch, moveBranchTo },
      repos: { get: (id) => (id === forRepo.id ? forRepo : undefined) },
    });
    return { sync, fetchBranch, moveBranchTo };
  }

  const origin = {
    kind: "github-pr" as const,
    url: "https://github.com/acme/app/pull/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };
  const pr = task({ origin, branch: "feature/pr", worktreePath: "/wt/pr" });

  it("fetches and moves the PR branch in its worktree, naming the repo's default branch", async () => {
    const { sync, fetchBranch, moveBranchTo } = prHead({ ...repo, defaultBranch: "develop" });
    await expect(sync.fetch(pr)).resolves.toBe("sha-remote");
    expect(fetchBranch).toHaveBeenCalledWith("/wt/pr", "feature/pr");

    await expect(sync.moveTo(pr, "sha-remote", "sha-local")).resolves.toBe(true);
    expect(moveBranchTo).toHaveBeenCalledWith(
      "/wt/pr",
      "feature/pr",
      "sha-remote",
      "sha-local",
      "develop",
    );
  });
});

describe("createWorkspaceRemover", () => {
  function remover(forRepo: Repo = repo) {
    const removeWorktree = vi.fn<(input: RemoveWorktreeInput) => Promise<void>>(
      async () => undefined,
    );
    const remove = createWorkspaceRemover({
      git: { removeWorktree, leaveBranch: vi.fn() },
      repos: { get: (id) => (id === forRepo.id ? forRepo : undefined) },
      claims: createInRepoClaims(),
    });
    return { remove, removeWorktree };
  }

  it("removes the worktree and deletes the task's own branch", async () => {
    const { remove, removeWorktree } = remover();
    await remove(task({ origin: { kind: "free-text" }, branch: "agent/t1", worktreePath: "/wt" }));
    expect(removeWorktree).toHaveBeenCalledWith({
      repoPath: "/code/app",
      worktreePath: "/wt",
      deleteBranch: "agent/t1",
      mainBranch: "main",
    });
  });

  it("names the repo's default branch so it is never deleted", async () => {
    const { remove, removeWorktree } = remover({ ...repo, defaultBranch: "develop" });
    await remove(task({ origin: { kind: "free-text" }, branch: "agent/t1", worktreePath: "/wt" }));
    expect(removeWorktree).toHaveBeenCalledWith({
      repoPath: "/code/app",
      worktreePath: "/wt",
      deleteBranch: "agent/t1",
      mainBranch: "develop",
    });
  });

  it("keeps a PR task's existing branch", async () => {
    const { remove, removeWorktree } = remover();
    const origin = {
      kind: "github-pr" as const,
      url: "https://github.com/acme/app/pull/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    };
    await remove(task({ origin, branch: "fix-login", worktreePath: "/wt" }));
    expect(removeWorktree).toHaveBeenCalledWith({
      repoPath: "/code/app",
      worktreePath: "/wt",
      mainBranch: "main",
    });
  });

  it("keeps the branch when asked to", async () => {
    const { remove, removeWorktree } = remover();
    await remove(task({ origin: { kind: "free-text" }, branch: "agent/t1", worktreePath: "/wt" }), {
      keepBranch: true,
    });
    expect(removeWorktree).toHaveBeenCalledWith({
      repoPath: "/code/app",
      worktreePath: "/wt",
      mainBranch: "main",
    });
  });
});

describe("in-repo tasks", () => {
  const inRepo = (patch: Partial<Task>) =>
    task({
      origin: { kind: "free-text" },
      title: "Fix login",
      inRepo: true,
      status: "running",
      ...patch,
    });

  function setup(listed: Task[] = []) {
    const tasks = [...listed];
    const claims = createInRepoClaims();
    const createWorktree = vi.fn<GitService["createWorktree"]>();
    const switchBranch = vi.fn<GitService["switchBranch"]>(async (input) => ({
      path: input.repoPath,
      branch: input.branch,
      baseSha: "abc",
    }));
    const leaveBranch = vi.fn<GitService["leaveBranch"]>(async () => undefined);
    const removeWorktree = vi.fn<GitService["removeWorktree"]>(async () => undefined);
    const repos = { get: (id: string) => (id === repo.id ? repo : undefined) };
    const prepare = createWorkspacePreparer({
      git: { createWorktree, switchBranch },
      repos,
      tasks: { list: () => tasks },
      claims,
    });
    const remove = createWorkspaceRemover({ git: { removeWorktree, leaveBranch }, repos, claims });
    return { tasks, claims, prepare, remove, createWorktree, switchBranch, leaveBranch };
  }

  it("checks the branch out in the repo's folder instead of a worktree", async () => {
    const { prepare, createWorktree, switchBranch } = setup();
    expect(await prepare(inRepo({}))).toEqual({
      branch: "agent/t1",
      worktreePath: "/code/app",
      baseBranch: null,
    });
    expect(switchBranch).toHaveBeenCalledWith({
      repoPath: "/code/app",
      branch: "agent/t1",
      base: "main",
    });
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("refuses while another active in-repo task holds the folder, naming it", async () => {
    const other = inRepo({ id: "t0", title: "Other work", worktreePath: "/code/app" });
    const { prepare, switchBranch } = setup([other]);
    await expect(prepare(inRepo({}))).rejects.toThrow(
      "The repo folder is in use by task Other work (t0); finish or delete it first",
    );
    expect(switchBranch).not.toHaveBeenCalled();
  });

  it("ignores done tasks, other repos, worktree tasks and the task itself", async () => {
    const { prepare, switchBranch } = setup([
      inRepo({ id: "t0", worktreePath: "/code/app", status: "done" }),
      inRepo({ id: "t2", repoId: "r2", worktreePath: "/code/other" }),
      task({ id: "t3", inRepo: false, worktreePath: "/wt", status: "running" }),
      inRepo({ worktreePath: "/code/app" }),
    ]);
    await prepare(inRepo({ worktreePath: "/code/app" }));
    expect(switchBranch).toHaveBeenCalledOnce();
  });

  it("lets only one of two tasks starting at once take the folder", async () => {
    const first = inRepo({ id: "t1" });
    const second = inRepo({ id: "t2" });
    const { prepare, switchBranch } = setup([first, second]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    switchBranch.mockImplementation(async (input) => {
      await gate;
      return { path: input.repoPath, branch: input.branch, baseSha: "abc" };
    });

    const both = [prepare(first), prepare(second)];
    release();
    const [a, b] = await Promise.allSettled(both);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason.message).toContain("Fix login (t1)");
    expect(switchBranch).toHaveBeenCalledOnce();
  });

  it("lets the next task in once the holder is done or removed", async () => {
    const first = inRepo({ id: "t1", branch: "agent/t1" });
    const second = inRepo({ id: "t2" });
    const { tasks, prepare, remove } = setup([first, second]);
    await prepare(first);
    await expect(prepare(second)).rejects.toThrow("in use");

    tasks[0] = { ...first, status: "done", worktreePath: "/code/app" };
    await prepare(second);

    // Removed instead: the claim goes with it.
    const third = inRepo({ id: "t3" });
    tasks.push(third);
    await expect(prepare(third)).rejects.toThrow("(t2)");
    tasks.splice(1, 1);
    await remove({ ...second, branch: "agent/t2", worktreePath: "/code/app" });
    await prepare(third);
  });

  it("releases the claim when switching the branch fails", async () => {
    const first = inRepo({ id: "t1" });
    const second = inRepo({ id: "t2" });
    const { prepare, switchBranch } = setup([first, second]);
    switchBranch.mockRejectedValueOnce(new Error("dirty"));
    await expect(prepare(first)).rejects.toThrow("dirty");
    await prepare(second);
  });

  it("prepares the claim holder again on resume", async () => {
    const { prepare, switchBranch } = setup();
    await prepare(inRepo({}));
    await prepare(inRepo({ branch: "agent/t1", worktreePath: "/code/app" }));
    expect(switchBranch).toHaveBeenCalledTimes(2);
  });

  it("leaves the branch instead of removing a worktree, deleting it only when it is the task's own", async () => {
    const { remove, leaveBranch } = setup();
    const done = inRepo({ branch: "agent/t1", worktreePath: "/code/app" });
    await remove(done);
    expect(leaveBranch).toHaveBeenLastCalledWith({
      repoPath: "/code/app",
      branch: "agent/t1",
      to: "main",
      deleteBranch: "agent/t1",
      mainBranch: "main",
    });
    await remove(done, { keepBranch: true });
    expect(leaveBranch).toHaveBeenLastCalledWith({
      repoPath: "/code/app",
      branch: "agent/t1",
      to: "main",
      mainBranch: "main",
    });
  });

  it("never removes the repo's folder", async () => {
    const { remove, leaveBranch } = setup();
    const removeWorktree = vi.fn<GitService["removeWorktree"]>();
    const own = createWorkspaceRemover({
      git: { removeWorktree, leaveBranch },
      repos: { get: () => repo },
      claims: createInRepoClaims(),
    });
    await own(inRepo({ branch: "agent/t1", worktreePath: "/code/app" }));
    await remove(inRepo({ branch: "agent/t1", worktreePath: "/code/app" }));
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});

describe("createWorkspaceSyncer", () => {
  const develop = { ...repo, defaultBranch: "develop" };

  function syncer(remote: string | null = "git@github.com:acme/app.git") {
    const remoteUrl = vi.fn(async () => remote);
    const fetchDefault = vi.fn(async () => undefined);
    const fastForwardTo = vi.fn(async () => ({ sha: "abc", onto: "origin/develop" }));
    const sync = createWorkspaceSyncer({
      git: { remoteUrl, fetchDefault, fastForwardTo },
      repos: { get: (id) => (id === develop.id ? develop : undefined) },
    });
    return { sync, remoteUrl, fetchDefault, fastForwardTo };
  }

  const started = (origin: Task["origin"]) =>
    task({ origin, branch: "feature/x", worktreePath: "/wt/app" });

  it("fetches the default branch, then fast-forwards free-text, Jira and GitHub issue tasks", async () => {
    const origins: Task["origin"][] = [
      { kind: "free-text" },
      { kind: "jira-issue", key: "ABC-1", connectionId: null },
      {
        kind: "github-issue",
        url: "https://github.com/acme/app/issues/7",
        owner: "acme",
        repo: "app",
        number: 7,
        connectionId: null,
      },
    ];
    for (const origin of origins) {
      const { sync, fetchDefault, fastForwardTo } = syncer();
      await expect(sync(started(origin))).resolves.toEqual({
        fetchError: null,
        fastForward: { sha: "abc", onto: "origin/develop" },
      });
      expect(fetchDefault).toHaveBeenCalledWith("/wt/app", "develop");
      expect(fastForwardTo).toHaveBeenCalledWith("/wt/app", "feature/x", "develop");
      expect(fetchDefault.mock.invocationCallOrder[0]).toBeLessThan(
        fastForwardTo.mock.invocationCallOrder[0]!,
      );
    }
  });

  it("skips the fetch without a remote", async () => {
    const { sync, fetchDefault, fastForwardTo } = syncer(null);
    await sync(started({ kind: "free-text" }));
    expect(fetchDefault).not.toHaveBeenCalled();
    expect(fastForwardTo).toHaveBeenCalled();
  });

  it("reports a failed fetch and still fast-forwards", async () => {
    const { sync, fetchDefault, fastForwardTo } = syncer();
    fetchDefault.mockRejectedValue(new GitError(["fetch"], "fatal: unable to access", 128));
    const result = await sync(started({ kind: "free-text" }));
    expect(result?.fetchError).toEqual(expect.any(String));
    expect(result?.fetchError).not.toBe("");
    expect(fastForwardTo).toHaveBeenCalled();
  });

  it("never moves PR branches or tasks without a worktree", async () => {
    const { sync, remoteUrl, fastForwardTo } = syncer();
    const pr = {
      kind: "github-pr" as const,
      url: "https://github.com/acme/app/pull/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    };
    await expect(sync(started(pr))).resolves.toBeNull();
    await expect(sync(task({ origin: { kind: "free-text" } }))).resolves.toBeNull();
    expect(remoteUrl).not.toHaveBeenCalled();
    expect(fastForwardTo).not.toHaveBeenCalled();
  });
});
