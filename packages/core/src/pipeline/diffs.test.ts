import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createBranchDiff, createTaskDiffs } from "./diffs.js";
import { REVIEW_DIFF_EVENT, type ReviewGit } from "./stages.js";

let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
});

afterEach(() => opened.close());

function fakeGit(head: string): ReviewGit {
  return {
    mainBranch: "main",
    headSha: async () => head,
    mergeBase: async () => "fork",
    diff: async (_worktree, from, to) => `diff ${from}..${to}`,
  };
}

function seedTask(worktreePath: string | null = "/wt/app") {
  const repo = r.repos.create({ path: "/code/app", name: "app" });
  return r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    worktreePath,
  });
}

function reviewStep(runId: string, round: number, from: string, to: string) {
  const step = r.steps.create({
    runId,
    stage: "code-review",
    agentId: null,
    round,
    visit: round,
    status: "succeeded",
  });
  r.stepEvents.append(step.id, REVIEW_DIFF_EVENT, { from, to });
}

describe("task diffs", () => {
  it("lists each reviewed round, then the commits since the last review", async () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    reviewStep(run.id, 0, "fork", "c1");
    reviewStep(run.id, 1, "c1", "c2");
    r.steps.create({
      runId: run.id,
      stage: "implement",
      agentId: null,
      round: 2,
      visit: 2,
      status: "succeeded",
    });

    const diffs = await createTaskDiffs({ repositories: r, git: fakeGit("c3") })(task);
    expect(diffs).toEqual([
      { round: 0, from: "fork", to: "c1", reviewed: true, diff: "diff fork..c1" },
      { round: 1, from: "c1", to: "c2", reviewed: true, diff: "diff c1..c2" },
      { round: 2, from: "c2", to: "c3", reviewed: false, diff: "diff c2..c3" },
    ]);
  });

  it("shows the branch since its fork point before any review, and nothing without a worktree", async () => {
    const task = seedTask();
    const taskDiffs = createTaskDiffs({ repositories: r, git: fakeGit("c1") });
    expect(await taskDiffs(task)).toEqual([
      { round: 0, from: "fork", to: "c1", reviewed: false, diff: "diff fork..c1" },
    ]);
    expect(await taskDiffs({ ...task, worktreePath: null })).toEqual([]);
  });
});

describe("branch diff", () => {
  it("diffs the whole branch from its fork point to HEAD, whatever the review rounds", async () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    reviewStep(run.id, 0, "fork", "c1");
    const branchDiff = createBranchDiff({ git: fakeGit("c2") });
    expect(await branchDiff(task)).toEqual({ from: "fork", to: "c2", diff: "diff fork..c2" });
  });

  it("is null without a worktree, a fork point or commits of its own", async () => {
    const task = seedTask();
    expect(await createBranchDiff({ git: fakeGit("c1") })({ ...task, worktreePath: null })).toBe(
      null,
    );
    expect(await createBranchDiff({ git: fakeGit("fork") })(task)).toBe(null);
    const noFork: ReviewGit = {
      ...fakeGit("c1"),
      mergeBase: async () => {
        throw new Error("no merge base");
      },
    };
    expect(await createBranchDiff({ git: noFork })(task)).toBe(null);
  });
});

describe("stacked PR diffs", () => {
  function seedPrTask(baseBranch: string | null) {
    const repo = r.repos.create({ path: "/code/app", name: "app" });
    return r.tasks.create({
      title: "Review stacked PR",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/app/pull/8",
        owner: "acme",
        repo: "app",
        number: 8,
        connectionId: null,
      },
      mode: "review",
      repoId: repo.id,
      branch: "feature/b",
      baseBranch,
      worktreePath: "/wt/app",
    });
  }

  function stackGit(head: string, parent: "tip" | "missing" = "tip"): ReviewGit {
    return {
      ...fakeGit(head),
      mergeBase: async (_worktree, ref) => {
        if (ref === "origin/feature/a" && parent === "tip") return "parent-tip";
        if (ref === "origin/main") return "main-fork";
        throw new Error(`no merge base with ${ref}`);
      },
    };
  }

  it("diffs a stacked PR from its base branch, not from main", async () => {
    const task = seedPrTask("feature/a");
    expect(await createBranchDiff({ git: stackGit("c1") })(task)).toEqual({
      from: "parent-tip",
      to: "c1",
      diff: "diff parent-tip..c1",
    });
    expect(await createTaskDiffs({ repositories: r, git: stackGit("c1") })(task)).toEqual([
      { round: 0, from: "parent-tip", to: "c1", reviewed: false, diff: "diff parent-tip..c1" },
    ]);
  });

  it("falls back to main without a base branch or when it cannot be found", async () => {
    const withoutBase = seedPrTask(null);
    expect((await createBranchDiff({ git: stackGit("c1") })(withoutBase))?.from).toBe("main-fork");
    const missing = { ...withoutBase, baseBranch: "feature/a" };
    expect((await createBranchDiff({ git: stackGit("c1", "missing") })(missing))?.from).toBe(
      "main-fork",
    );
    expect(
      (await createTaskDiffs({ repositories: r, git: stackGit("c1", "missing") })(missing))[0]
        ?.from,
    ).toBe("main-fork");
  });
});
