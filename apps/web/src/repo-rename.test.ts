import type { ConnectionView } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { renameDisabledReason, renamePreview, sessionResetTasks, stepStates } from "./repo-rename";
import { makeRepo, makeTask } from "./test-fixtures";

const connection = { id: "c1", kind: "github", name: "github.com" } as ConnectionView;

describe("renameDisabledReason", () => {
  it("names the first thing in the way", () => {
    const repo = makeRepo();
    expect(renameDisabledReason(repo, connection, [], false)).toBeNull();
    expect(renameDisabledReason(makeRepo({ exists: false }), connection, [], true)).toBe(
      "Folder is missing",
    );
    expect(
      renameDisabledReason(repo, connection, [makeTask({ repoId: "r1", status: "running" })], true),
    ).toBe("A task in this repo is queued, running or delivering");
    expect(
      renameDisabledReason(
        repo,
        connection,
        [makeTask({ repoId: "r1", status: "needs-you", delivering: true })],
        false,
      ),
    ).toBe("A task in this repo is queued, running or delivering");
    expect(
      renameDisabledReason(
        repo,
        connection,
        [makeTask({ repoId: "r2", status: "running" })],
        false,
      ),
    ).toBeNull();
    expect(
      renameDisabledReason(makeRepo({ remoteUrl: "C:\\bare\\app" }), connection, [], false),
    ).toBe("Origin is not a GitHub repo");
    expect(renameDisabledReason(repo, undefined, [], false)).toBe(
      "No GitHub connection for github.com",
    );
    expect(renameDisabledReason(repo, connection, [], true)).toBe(
      "Save or discard your changes first",
    );
  });
});

describe("renamePreview", () => {
  it("shows the new GitHub address, origin and folder", () => {
    expect(renamePreview(makeRepo(), "shop")).toEqual({
      githubUrl: "https://github.com/acme/shop",
      origin: "git@github.com:acme/shop.git",
      path: "C:\\Code\\shop",
    });
    expect(renamePreview(makeRepo({ remoteUrl: null, path: "/code/app" }), "shop")).toEqual({
      githubUrl: null,
      origin: null,
      path: "/code/shop",
    });
  });
});

describe("stepStates", () => {
  it("marks each step done, already done, failed or not run", () => {
    expect(stepStates(null)).toEqual({
      github: "not-run",
      origin: "not-run",
      folder: "not-run",
      records: "not-run",
    });
    expect(
      stepStates({
        repo: makeRepo(),
        completed: ["origin"],
        skipped: ["github"],
        failed: { step: "folder", message: "in use" },
      }),
    ).toEqual({ github: "already", origin: "done", folder: "failed", records: "not-run" });
  });
});

describe("sessionResetTasks", () => {
  it("lists paused, failed and interrupted tasks with a worktree under the repo", () => {
    const repo = makeRepo();
    const paused = makeTask({ worktreePath: "C:\\Code\\app.worktrees\\t1", status: "needs-you" });
    const failed = makeTask({ worktreePath: "C:/Code/app.worktrees/t2", status: "failed" });
    const interrupted = makeTask({
      worktreePath: "C:\\Code\\app.worktrees\\t3",
      status: "interrupted",
    });
    const done = makeTask({ worktreePath: "C:\\Code\\app.worktrees\\t4", status: "done" });
    const elsewhere = makeTask({ worktreePath: "C:\\Elsewhere\\t5", status: "needs-you" });
    const sibling = makeTask({ worktreePath: "C:\\Code\\app.worktrees2\\t6", status: "failed" });
    const none = makeTask({ status: "needs-you" });
    expect(
      sessionResetTasks(repo, [paused, failed, interrupted, done, elsewhere, sibling, none]),
    ).toEqual([paused, failed, interrupted]);
  });
});
