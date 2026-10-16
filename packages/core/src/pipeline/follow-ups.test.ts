import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backlogItemSchema, type FollowUp, type Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { nextBacklogItem } from "./backlog.js";
import { createFollowUpTasks, followUpsPromptSection, resolveFollowUps } from "./follow-ups.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;
let task: Task;
let otherId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-follow-ups-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
  const repo = r.repos.create({ path: "/code/app", name: "app" });
  otherId = r.repos.create({ path: "/code/api", name: "api" }).id;
  task = r.tasks.create({
    title: "Plan the work",
    origin: { kind: "free-text" },
    repoId: repo.id,
    triageMode: "pause",
  });
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const followUp = (title: string, repoId: string | null): FollowUp => ({
  title,
  description: `Do ${title}`,
  repoId,
});

describe("resolveFollowUps", () => {
  it("resolves null to the task's repo and keeps a registered one", () => {
    const items = resolveFollowUps(
      task,
      [followUp("A", null), followUp("B", otherId)],
      r.repos.list(),
    );
    expect(items).toEqual([
      { title: "A", description: "Do A", repoId: task.repoId, repoName: "app" },
      { title: "B", description: "Do B", repoId: otherId, repoName: "api" },
    ]);
  });

  it("falls back to the task's repo for an unknown one, with a note", () => {
    const [item] = resolveFollowUps(task, [followUp("A", "gone")], r.repos.list());
    expect(item).toEqual({
      title: "A",
      description: "Do A\n\nProposed for repo `gone`, which is not registered.",
      repoId: task.repoId,
      repoName: "app",
    });
  });
});

describe("createFollowUpTasks", () => {
  it("creates independent, linked, waiting free-text items the runner picks", () => {
    r.backlogItems.insert({ repoId: task.repoId, title: "Older", origin: { kind: "free-text" } });
    const items = resolveFollowUps(
      task,
      [followUp("A", null), followUp("B", otherId)],
      r.repos.list(),
    );
    const created = createFollowUpTasks({ task, items, backlogItems: r.backlogItems });
    expect(created.map((i) => backlogItemSchema.parse(i))).toMatchObject([
      {
        repoId: task.repoId,
        title: "A",
        origin: { kind: "free-text" },
        mode: null,
        freeText: "Do A",
        agents: {},
        triageMode: "pause",
        position: 1,
        dependsOn: [],
        status: "waiting",
        taskId: null,
        sourceTaskId: task.id,
      },
      { repoId: otherId, title: "B", position: 0, sourceTaskId: task.id },
    ]);
    expect(nextBacklogItem(r.backlogItems.list(otherId), () => false)?.title).toBe("B");
  });
});

describe("followUpsPromptSection", () => {
  it("lists the repos by id and states the independence rules", () => {
    const text = followUpsPromptSection(r.repos.list(), task);
    expect(text).toContain(`\`${task.repoId}\`: app (this task's repo)`);
    expect(text).toContain(`\`${otherId}\`: api`);
    expect(text).toContain("Each follow-up must be independent");
    expect(text).toContain("Do not split a sequence into separate follow-ups");
    expect(text).toContain("propose them as its own follow-ups once it is done");
    expect(text).toContain("at most 5");
  });
});
