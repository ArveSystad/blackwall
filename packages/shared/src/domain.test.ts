import { describe, expect, it } from "vitest";
import {
  connectionInputSchema,
  connectionViewSchema,
  findingSchema,
  grillQuestionSchema,
  isGatingSeverity,
  newTaskInputSchema,
  repoInputSchema,
  repoScanInputSchema,
  settingsSchema,
  taskSchema,
} from "./domain.js";

const now = "2026-10-08T10:00:00.000Z";

const task = {
  id: "t1",
  title: "Fix login",
  origin: { kind: "jira-issue", key: "ABC-123", connectionId: "c1" },
  mode: null,
  repoId: "r1",
  branch: "feature/abc-123-fix-login",
  worktreePath: null,
  status: "needs-you",
  stage: "plan-review",
  triageMode: "intervene",
  agents: { planner: "a1", codeReviewers: ["a2", "a3"] },
  deliveryTargets: ["push-branch", "open-pr", "jira-comment"],
  freeText: "",
  plan: null,
  createdAt: now,
  updatedAt: now,
};

describe("taskSchema", () => {
  it("parses a task from JSON, reviving timestamps", () => {
    const parsed = taskSchema.parse(task);
    expect(parsed.createdAt).toEqual(new Date(now));
    expect(parsed.origin).toEqual({ kind: "jira-issue", key: "ABC-123", connectionId: "c1" });
  });

  it("rejects unknown statuses and bad Jira keys", () => {
    expect(taskSchema.safeParse({ ...task, status: "pending" }).success).toBe(false);
    expect(
      taskSchema.safeParse({
        ...task,
        origin: { kind: "jira-issue", key: "abc", connectionId: null },
      }).success,
    ).toBe(false);
  });

  it("requires a mode for PR tasks only", () => {
    const pr = {
      kind: "github-pr",
      url: "https://github.com/acme/web/pull/42",
      owner: "acme",
      repo: "web",
      number: 42,
      connectionId: null,
    };
    expect(taskSchema.safeParse({ ...task, origin: pr, mode: "review" }).success).toBe(true);
    expect(taskSchema.safeParse({ ...task, origin: pr, mode: null }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, mode: "work" }).success).toBe(false);
  });
});

describe("newTaskInputSchema", () => {
  it("fills defaults", () => {
    expect(
      newTaskInputSchema.parse({
        origin: { kind: "free-text" },
        repoId: "r1",
        freeText: "Add dark mode",
      }),
    ).toEqual({
      origin: { kind: "free-text" },
      mode: null,
      repoId: "r1",
      freeText: "Add dark mode",
      agents: {},
      triageMode: "intervene",
    });
  });

  it("requires a description for free-text tasks", () => {
    const result = newTaskInputSchema.safeParse({ origin: { kind: "free-text" }, repoId: "r1" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["freeText"]);
  });
});

describe("findingSchema", () => {
  const finding = {
    id: "f1",
    taskId: "t1",
    runId: null,
    stepId: null,
    reviewerAgentId: "a2",
    severity: "high",
    tags: ["security"],
    file: "src/auth.ts",
    lineStart: 10,
    lineEnd: 12,
    title: "Token logged",
    explanation: "The token is written to stdout.",
    suggestedFix: null,
    status: "open",
    round: 0,
    createdAt: now,
    updatedAt: now,
  };

  it("accepts a valid finding and rejects an inverted line range", () => {
    expect(findingSchema.safeParse(finding).success).toBe(true);
    expect(findingSchema.safeParse({ ...finding, lineEnd: 9 }).success).toBe(false);
    expect(findingSchema.safeParse({ ...finding, severity: "blocker" }).success).toBe(false);
  });

  it("gates on critical and high only", () => {
    expect(["critical", "high", "medium", "low"].map((s) => isGatingSeverity(s as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("grillQuestionSchema", () => {
  it("carries needsHuman and who answered", () => {
    const q = grillQuestionSchema.parse({
      id: "q1",
      taskId: "t1",
      runId: null,
      stepId: null,
      askedByAgentId: "a2",
      question: "Keep the old endpoint?",
      needsHuman: true,
      answer: "Yes, for one release",
      answeredBy: "user",
      createdAt: now,
      answeredAt: now,
    });
    expect(q.needsHuman).toBe(true);
    expect(q.answeredAt).toBeInstanceOf(Date);
  });
});

describe("settings and inputs", () => {
  it("defaults settings", () => {
    expect(settingsSchema.parse({})).toEqual({ roleDefaults: {}, maxTasksPerRepo: 3 });
    expect(settingsSchema.safeParse({ maxTasksPerRepo: 0 }).success).toBe(false);
  });

  it("leaves repo check commands unset so they can be suggested", () => {
    expect(repoInputSchema.parse({ path: " /code/app " })).toEqual({ path: "/code/app" });
    expect(repoInputSchema.parse({ path: "/code/app", checkCommands: [] }).checkCommands).toEqual(
      [],
    );
  });

  it("defaults the repo scan depth", () => {
    expect(repoScanInputSchema.parse({ root: "/code" })).toEqual({ root: "/code", maxDepth: 3 });
    expect(repoScanInputSchema.safeParse({ root: "/code", maxDepth: 99 }).success).toBe(false);
  });
});

describe("connectionViewSchema", () => {
  const view = {
    id: "c1",
    name: "jbf.ghe.com",
    kind: "github",
    baseUrl: "https://jbf.ghe.com",
    authMeta: {},
    hasToken: true,
    createdAt: now,
    updatedAt: now,
  };

  it("exposes hasToken and rejects any extra field", () => {
    expect(connectionViewSchema.parse(view).hasToken).toBe(true);
    expect(connectionViewSchema.safeParse({ ...view, token: "secret" }).success).toBe(false);
    expect(connectionViewSchema.safeParse({ ...view, tokenSet: true }).success).toBe(false);
  });
});

describe("connectionInputSchema", () => {
  const github = { name: "github.com", kind: "github", baseUrl: "https://github.com" };

  it("defaults authMeta and accepts an optional token", () => {
    expect(connectionInputSchema.parse(github)).toEqual({ ...github, authMeta: {} });
    expect(connectionInputSchema.parse({ ...github, token: " t " }).token).toBe("t");
    expect(connectionInputSchema.safeParse({ ...github, token: " " }).success).toBe(false);
  });

  it("requires the account email for Jira", () => {
    const jira = { name: "acme", kind: "jira", baseUrl: "https://acme.atlassian.net" };
    expect(connectionInputSchema.safeParse(jira).success).toBe(false);
    expect(
      connectionInputSchema.safeParse({ ...jira, authMeta: { email: "not-an-email" } }).success,
    ).toBe(false);
    expect(
      connectionInputSchema.safeParse({ ...jira, authMeta: { email: "me@acme.test" } }).success,
    ).toBe(true);
  });
});
