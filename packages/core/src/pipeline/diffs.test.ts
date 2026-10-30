import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createGitService } from "../git/service.js";
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
    headSha: async () => head,
    mergeBase: async () => "fork",
    diff: async (_worktree, from, to) => `diff ${from}..${to}`,
    commitsSince: async () => 0,
    isAncestor: async () => true,
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

  it("shows a range reviewed again once, as a review task's Review again does", async () => {
    const task = seedTask();
    const run = r.runs.create(task.id);
    reviewStep(run.id, 0, "fork", "c1");
    reviewStep(run.id, 1, "fork", "c1");

    const diffs = await createTaskDiffs({ repositories: r, git: fakeGit("c1") })(task);
    expect(diffs).toEqual([
      { round: 0, from: "fork", to: "c1", reviewed: true, diff: "diff fork..c1" },
    ]);
  });

  it("shows only the latest run's range after a re-review", async () => {
    const task = seedTask();
    const first = r.runs.create(task.id);
    reviewStep(first.id, 0, "fork", "c1");
    const second = r.runs.create(task.id);
    reviewStep(second.id, 0, "c1", "c2");

    const diffs = await createTaskDiffs({ repositories: r, git: fakeGit("c2") })(task);
    expect(diffs).toEqual([
      { round: 0, from: "c1", to: "c2", reviewed: true, diff: "diff c1..c2" },
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
    const branchDiff = createBranchDiff({ git: fakeGit("c2"), repositories: r });
    expect(await branchDiff(task)).toEqual({ from: "fork", to: "c2", diff: "diff fork..c2" });
  });

  it("is null without a worktree, a fork point or commits of its own", async () => {
    const task = seedTask();
    expect(
      await createBranchDiff({ git: fakeGit("c1"), repositories: r })({
        ...task,
        worktreePath: null,
      }),
    ).toBe(null);
    expect(await createBranchDiff({ git: fakeGit("fork"), repositories: r })(task)).toBe(null);
    const noFork: ReviewGit = {
      ...fakeGit("c1"),
      mergeBase: async () => {
        throw new Error("no merge base");
      },
    };
    expect(await createBranchDiff({ git: noFork, repositories: r })(task)).toBe(null);
  });

  it("forks from the repo's default branch", async () => {
    const task = seedTask();
    r.repos.update(task.repoId, { defaultBranch: "develop" });
    const developGit: ReviewGit = {
      ...fakeGit("c1"),
      mergeBase: async (_worktree, ref) => {
        if (ref === "develop") return "develop-fork";
        throw new Error(`no merge base with ${ref}`);
      },
    };
    expect((await createBranchDiff({ git: developGit, repositories: r })(task))?.from).toBe(
      "develop-fork",
    );
    expect((await createTaskDiffs({ repositories: r, git: developGit })(task))[0]?.from).toBe(
      "develop-fork",
    );
  });

  it("forks from the nearer of the local and remote default branch", async () => {
    const task = seedTask();
    r.repos.update(task.repoId, { defaultBranch: "develop" });
    const forks: Record<string, string> = { develop: "old-local", "origin/develop": "remote-tip" };
    const commits: Record<string, number> = { "old-local": 5, "remote-tip": 1 };
    const aheadGit: ReviewGit = {
      ...fakeGit("c1"),
      mergeBase: async (_worktree, ref) => forks[ref]!,
      commitsSince: async (_worktree, base) => commits[base]!,
    };
    expect((await createBranchDiff({ git: aheadGit, repositories: r })(task))?.from).toBe(
      "remote-tip",
    );

    commits["old-local"] = 0;
    expect((await createBranchDiff({ git: aheadGit, repositories: r })(task))?.from).toBe(
      "old-local",
    );
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
    expect(await createBranchDiff({ git: stackGit("c1"), repositories: r })(task)).toEqual({
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
    expect(
      (await createBranchDiff({ git: stackGit("c1"), repositories: r })(withoutBase))?.from,
    ).toBe("main-fork");
    const missing = { ...withoutBase, baseBranch: "feature/a" };
    expect(
      (await createBranchDiff({ git: stackGit("c1", "missing"), repositories: r })(missing))?.from,
    ).toBe("main-fork");
    expect(
      (await createTaskDiffs({ repositories: r, git: stackGit("c1", "missing") })(missing))[0]
        ?.from,
    ).toBe("main-fork");
  });
});

describe("in-repo task diffs", () => {
  let root: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const commit = (cwd: string, file: string, content: string) => {
    writeFileSync(join(cwd, file), content);
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", `edit ${file}`);
    return git(cwd, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-diffs-")));
    git(root, "init", "--quiet", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.autocrlf", "false");
    commit(root, "README.md", "hello\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("shows the task's branch after the folder moved to another branch", async () => {
    const fork = git(root, "rev-parse", "HEAD");
    git(root, "switch", "--quiet", "-c", "agent/t1");
    const tip = commit(root, "task.txt", "task\n");
    git(root, "switch", "--quiet", "-c", "agent/t2", "main");
    commit(root, "other.txt", "other\n");

    const repo = r.repos.create({ path: root, name: "app" });
    const fields = {
      title: "Fix login",
      origin: { kind: "free-text" as const },
      repoId: repo.id,
      branch: "agent/t1",
      worktreePath: root,
    };
    const task = r.tasks.create({ ...fields, inRepo: true });
    const service = createGitService();

    const branch = await createBranchDiff({ git: service, repositories: r })(task);
    expect(branch).toMatchObject({ from: fork, to: tip });
    expect(branch?.diff).toContain("task.txt");
    expect(branch?.diff).not.toContain("other.txt");

    const [round] = await createTaskDiffs({ repositories: r, git: service })(task);
    expect(round).toMatchObject({ from: fork, to: tip });
    expect(round?.diff).toContain("task.txt");

    // A worktree task reads the folder's HEAD, as before.
    const worktreeTask = r.tasks.create(fields);
    expect(
      (await createBranchDiff({ git: service, repositories: r })(worktreeTask))?.diff,
    ).toContain("other.txt");
  });
});
