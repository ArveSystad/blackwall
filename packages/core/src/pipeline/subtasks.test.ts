import { MAX_SUBTASKS, type Task } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  canSplit,
  hasSubtasksHeading,
  parseSubtasks,
  subtaskReport,
  subtasksExtractionPrompt,
  subtasksPromptSection,
} from "./subtasks.js";

const repos = [
  { id: "app", name: "app", defaultBranch: "main" },
  { id: "api", name: "api", defaultBranch: "develop" },
  { id: "web", name: "web", defaultBranch: "main" },
];

const base = {
  id: "t1",
  repoId: "app",
  mode: null,
  origin: { kind: "free-text" as const },
  parentTaskId: null,
  referenceRepoIds: ["api"],
} as const;

const asTask = (patch: Partial<Task> = {}) => ({ ...base, ...patch }) as unknown as Task;

describe("canSplit", () => {
  it("allows a work task with a registered reference repo", () => {
    expect(canSplit(asTask(), repos)).toBe(true);
  });

  it("refuses review mode, PR origins, subtasks and tasks without a registered reference repo", () => {
    const pr = {
      kind: "github-pr" as const,
      url: "https://github.com/acme/app/pull/1",
      owner: "acme",
      repo: "app",
      number: 1,
      connectionId: null,
    };
    expect(canSplit(asTask({ mode: "review", origin: pr }), repos)).toBe(false);
    expect(canSplit(asTask({ mode: "work", origin: pr }), repos)).toBe(false);
    expect(canSplit(asTask({ parentTaskId: "p1" }), repos)).toBe(false);
    expect(canSplit(asTask({ referenceRepoIds: ["gone"] }), repos)).toBe(false);
    expect(canSplit(asTask({ referenceRepoIds: [] }), repos)).toBe(false);
  });
});

describe("parseSubtasks", () => {
  const options = { task: asTask({ referenceRepoIds: ["api", "web", "gone"] }), repos };
  const entry = (repoId: string, n = 1) => ({
    repoId,
    title: `Part ${n}`,
    description: `Do part ${n}`,
  });

  it("keeps valid entries for the task's repos, the first per repo", () => {
    const parsed = parseSubtasks(
      {
        subtasks: [
          entry("app"),
          entry("api", 2),
          entry("gone", 3),
          entry("api", 4),
          { repoId: "web", title: "", description: "x" },
          "oops",
        ],
      },
      options,
    );
    expect(parsed.subtasks).toEqual([entry("app"), entry("api", 2)]);
    expect(parsed.dropped).toEqual([
      { index: 2, reason: "unknown-repo" },
      { index: 3, reason: "duplicate-repo" },
      { index: 4, reason: "invalid" },
      { index: 5, reason: "invalid" },
    ]);
  });

  it("returns none when only the task's own repo remains", () => {
    expect(parseSubtasks({ subtasks: [entry("app"), entry("gone")] }, options).subtasks).toEqual(
      [],
    );
    expect(parseSubtasks(undefined, options).subtasks).toEqual([]);
  });

  it(`keeps at most ${MAX_SUBTASKS}`, () => {
    const many = Array.from({ length: MAX_SUBTASKS + 2 }, (_, i) => ({
      id: `r${i}`,
      name: `r${i}`,
      defaultBranch: "main",
    }));
    const task = asTask({ referenceRepoIds: many.map((r) => r.id) });
    const parsed = parseSubtasks(
      { subtasks: many.map((r, i) => entry(r.id, i)) },
      { task, repos: [...repos, ...many] },
    );
    expect(parsed.subtasks).toHaveLength(MAX_SUBTASKS);
    expect(parsed.dropped.map((d) => d.reason)).toEqual(["over-limit", "over-limit"]);
  });
});

describe("hasSubtasksHeading", () => {
  it("matches a level 3 Subtasks heading only", () => {
    expect(hasSubtasksHeading("## Plan\n\n### Subtasks\n\n- api")).toBe(true);
    expect(hasSubtasksHeading("### subtasks  ")).toBe(true);
    expect(hasSubtasksHeading("## Subtasks")).toBe(false);
    expect(hasSubtasksHeading("### Subtasks and more")).toBe(false);
    expect(hasSubtasksHeading("Subtasks")).toBe(false);
    expect(hasSubtasksHeading(null)).toBe(false);
  });
});

describe("subtasksPromptSection", () => {
  it("lists the repos the task may split into, with the follow-up rule", () => {
    const section = subtasksPromptSection(repos, asTask());
    expect(section).toContain("`app`: app (this task's repo)");
    expect(section).toContain("`api`: api");
    expect(section).not.toContain("`web`");
    expect(section).toContain("write `None.` under `### Follow-up tasks`");
    expect(subtasksExtractionPrompt()).toContain("Follow-ups to propose:");
  });

  it("is empty when the task can't be split", () => {
    expect(subtasksPromptSection(repos, asTask({ parentTaskId: "p1" }))).toBe("");
  });
});

describe("subtaskReport", () => {
  const child = (id: string, repoId: string, deliveryTargets: string[]) =>
    ({ id, repoId, title: `Change ${repoId}`, deliveryTargets }) as unknown as Task;
  const repositories = {
    repos: { get: (id: string) => repos.find((r) => r.id === id) },
  } as unknown as Parameters<typeof subtaskReport>[0];

  it("links each subtask's pull request, or says how it was delivered", () => {
    const urls: Record<string, string> = { a: "https://github.com/acme/app/pull/3" };
    const report = subtaskReport(
      repositories,
      [
        child("a", "app", ["push-branch", "open-pr"]),
        child("b", "api", ["merge-main"]),
        child("c", "web", []),
      ],
      (id) => urls[id],
    );
    expect(report).toBe(
      [
        "Solved with these pull requests:",
        "",
        "- app: Change app — https://github.com/acme/app/pull/3",
        "- api: Change api — merged into `develop` locally",
        "- web: Change web — no pull request",
      ].join("\n"),
    );
  });
});
