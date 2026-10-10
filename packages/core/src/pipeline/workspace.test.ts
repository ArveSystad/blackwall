import type { Repo, Task } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import type { CreateWorktreeInput, RemoveWorktreeInput } from "../git/service.js";
import { worktreePathFor } from "../git/branches.js";
import { createWorkspacePreparer, createWorkspaceRemover } from "./workspace.js";

const repo = { id: "r1", path: "/code/app", name: "app" } as Repo;

function preparer() {
  const createWorktree = vi.fn(async (input: CreateWorktreeInput) => ({
    path: input.worktreePath,
    branch: input.branch,
    baseSha: "abc",
  }));
  const prepare = createWorkspacePreparer({
    git: { createWorktree },
    repos: { get: (id) => (id === repo.id ? repo : undefined) },
  });
  return { prepare, createWorktree };
}

const task = (patch: Partial<Task>) =>
  ({ id: "t1", repoId: "r1", branch: null, worktreePath: null, ...patch }) as Task;

describe("createWorkspacePreparer", () => {
  it("creates agent/<task-id> next to the repo for free-text tasks", async () => {
    const { prepare, createWorktree } = preparer();
    const ws = await prepare(task({ origin: { kind: "free-text" } }));
    expect(ws).toEqual({ branch: "agent/t1", worktreePath: worktreePathFor("/code/app", "t1") });
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "agent/t1", checkout: { kind: "new" } }),
    );
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

  it("asks branchFor for a Jira task's new branch", async () => {
    const createWorktree = vi.fn(async (input: CreateWorktreeInput) => ({
      path: input.worktreePath,
      branch: input.branch,
      baseSha: "abc",
    }));
    const branchFor = vi.fn(async () => "feature/abc-1-export");
    const prepare = createWorkspacePreparer({
      git: { createWorktree },
      repos: { get: () => repo },
      branchFor,
    });
    const ws = await prepare(
      task({ origin: { kind: "jira-issue", key: "ABC-1", connectionId: null } }),
    );
    expect(ws.branch).toBe("feature/abc-1-export");
    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feature/abc-1-export", checkout: { kind: "new" } }),
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
      git: { createWorktree },
      repos: { get: () => repo },
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
      expect.objectContaining({ branch: "fix/7-export-drops-a-row", checkout: { kind: "new" } }),
    );
  });
});

describe("createWorkspaceRemover", () => {
  function remover() {
    const removeWorktree = vi.fn<(input: RemoveWorktreeInput) => Promise<void>>(
      async () => undefined,
    );
    const remove = createWorkspaceRemover({
      git: { removeWorktree },
      repos: { get: (id) => (id === repo.id ? repo : undefined) },
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
    expect(removeWorktree).toHaveBeenCalledWith({ repoPath: "/code/app", worktreePath: "/wt" });
  });
});
