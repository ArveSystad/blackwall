import type { Repo, Task } from "@blackwall/shared";
import { describe, expect, it, vi } from "vitest";
import type { CreateWorktreeInput } from "../git/service.js";
import { worktreePathFor } from "../git/branches.js";
import { createWorkspacePreparer } from "./workspace.js";

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
});
