import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createTaskDiffs } from "./diffs.js";
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
