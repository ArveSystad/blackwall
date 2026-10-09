import { findingSchema, type Finding, type StepEvent } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { TASK_STOPPED_ERROR } from "@blackwall/shared";
import {
  agentClis,
  canArchive,
  canStop,
  deleteBlockedReason,
  deleteTaskCopy,
  isStoppedByUser,
  buildTranscript,
  checkRuns,
  confirmLabel,
  currentActivity,
  currentRound,
  defaultStepId,
  defaultTab,
  deliveryActionCopy,
  deliveryConflicts,
  diffStat,
  findingLocation,
  gateBanner,
  isBlocking,
  isTabEnabled,
  jiraConnectionId,
  latestHarnessStep,
  latestStep,
  looksLikeDiff,
  openQuestionCount,
  parseDiff,
  parseJiraInput,
  sortFindings,
  toolTarget,
  visibleFindings,
} from "./task-view";
import { makeTask } from "./test-fixtures";

function event(seq: number, type: string, payload: unknown): StepEvent {
  return { stepId: "s1", seq, type, payload, createdAt: new Date("2026-10-08T10:00:00Z") };
}

let findingSeq = 0;
function finding(overrides: Partial<Finding> = {}): Finding {
  findingSeq += 1;
  return findingSchema.parse({
    id: `f${findingSeq}`,
    taskId: "t1",
    runId: null,
    stepId: null,
    reviewerAgentId: null,
    severity: "medium",
    tags: [],
    file: null,
    lineStart: null,
    lineEnd: null,
    title: `Finding ${findingSeq}`,
    explanation: "",
    suggestedFix: null,
    status: "open",
    mergedIntoId: null,
    round: 0,
    createdAt: "2026-10-08T10:00:00Z",
    updatedAt: "2026-10-08T10:00:00Z",
    ...overrides,
  });
}

describe("parseDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@ export function a() {",
    " const x = 1;",
    "-return x;",
    "+const y = 2;",
    "+return x + y;",
    " }",
    "diff --git a/old.ts b/old.ts",
    "deleted file mode 100644",
    "--- a/old.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "",
  ].join("\n");

  it("splits files and numbers lines from the hunk headers", () => {
    const files = parseDiff(diff);
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ["src/a.ts", 2, 1],
      ["old.ts", 0, 1],
    ]);
    expect(files[0]!.lines.map((l) => [l.kind, l.line, l.text])).toEqual([
      ["hunk", null, "@@ -10,3 +10,4 @@ export function a() {"],
      ["ctx", 10, "const x = 1;"],
      ["del", 11, "return x;"],
      ["add", 11, "const y = 2;"],
      ["add", 12, "return x + y;"],
      ["ctx", 13, "}"],
    ]);
    expect(diffStat(files)).toEqual({ additions: 2, deletions: 2 });
  });

  it("tells a diff from prose", () => {
    expect(looksLikeDiff("@@ -1 +1 @@\n-a\n+b")).toBe(true);
    expect(looksLikeDiff("Use a mutex around the refresh.")).toBe(false);
  });
});

describe("currentActivity", () => {
  const read = event(1, "tool-call-start", {
    id: "c1",
    name: "Read",
    input: { file_path: "src/x.ts" },
  });

  it("is null before the agent does anything", () => {
    expect(currentActivity([])).toBeNull();
    expect(currentActivity([event(1, "session", { sessionId: "x" })])).toBeNull();
  });

  it("names the latest tool call and its target", () => {
    expect(currentActivity([read])).toBe("Read src/x.ts");
  });

  it("shows the first line of a later message", () => {
    expect(currentActivity([read, event(2, "message", { text: "Done reading." })])).toBe(
      "Done reading.",
    );
    expect(currentActivity([event(1, "message", { text: "\n  First line\nSecond line" })])).toBe(
      "First line",
    );
  });

  it("cuts a long message", () => {
    const activity = currentActivity([event(1, "message", { text: "x".repeat(200) })]);
    expect(activity).toHaveLength(120);
    expect(activity?.endsWith("…")).toBe(true);
  });

  it("shows an error's message", () => {
    expect(currentActivity([read, event(2, "error", { message: "rate limited" })])).toBe(
      "rate limited",
    );
  });
});

describe("buildTranscript", () => {
  it("pairs tool calls with their results and drops bookkeeping events", () => {
    const items = buildTranscript([
      event(1, "session", { sessionId: "x" }),
      event(2, "message", { text: "Reading the file." }),
      event(3, "tool-call-start", { id: "c1", name: "Read", input: { file_path: "src/a.ts" } }),
      event(4, "tool-call-start", { id: "c2", name: "Bash", input: { command: "pnpm test" } }),
      event(5, "tool-call-end", { id: "c1", output: "contents", isError: false }),
      event(6, "error", { message: "rate limited" }),
      event(7, "usage", { tokens: 10 }),
    ]);
    expect(items).toEqual([
      { kind: "message", key: "s1:2", text: "Reading the file." },
      {
        kind: "tool",
        key: "s1:3",
        name: "Read",
        target: "src/a.ts",
        input: { file_path: "src/a.ts" },
        output: "contents",
        isError: false,
      },
      {
        kind: "tool",
        key: "s1:4",
        name: "Bash",
        target: "pnpm test",
        input: { command: "pnpm test" },
        output: null,
        isError: false,
      },
      { kind: "error", key: "s1:6", message: "rate limited" },
    ]);
  });

  it("folds check commands into one run each", () => {
    const runs = checkRuns([
      event(1, "check.started", { command: "pnpm lint" }),
      event(2, "check.finished", { command: "pnpm lint", exitCode: 0, output: "ok" }),
      event(3, "check.started", { command: "pnpm test" }),
    ]);
    expect(runs).toEqual([
      { command: "pnpm lint", exitCode: 0, output: "ok", timedOut: false, running: false },
      { command: "pnpm test", exitCode: null, output: "", timedOut: false, running: true },
    ]);
  });

  it("names a tool call by its file, command or pattern", () => {
    expect(toolTarget({ pattern: "TODO", path: "src" })).toBe("src");
    expect(toolTarget({ command: "git status\ngit log" })).toBe("git status");
    expect(toolTarget({})).toBe("");
    expect(toolTarget({ a: 1 })).toBe('{"a":1}');
  });
});

describe("tabs and banner", () => {
  it("opens where the user is needed", () => {
    expect(defaultTab(makeTask({ status: "needs-you", gate: "questions" }))).toBe("grill");
    expect(defaultTab(makeTask({ status: "needs-you", gate: "plan-approval" }))).toBe("plan");
    expect(defaultTab(makeTask({ status: "needs-you", gate: "triage" }))).toBe("findings");
    expect(defaultTab(makeTask({ status: "running", stage: "implement" }))).toBe("output");
    expect(defaultTab(makeTask({ status: "failed" }))).toBe("context");
  });

  it("opens Finish for a Review PR task at triage", () => {
    const task = makeTask({
      status: "needs-you",
      gate: "triage",
      mode: "review",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/web/pull/1",
        owner: "acme",
        repo: "web",
        number: 1,
        connectionId: null,
      },
    });
    expect(defaultTab(task)).toBe("finish");
    expect(isTabEnabled(task, "finish")).toBe(true);
    expect(isTabEnabled(task, "grill")).toBe(false);
  });

  it("keeps tabs disabled until their stage", () => {
    const task = makeTask({ status: "running", stage: "implement" });
    expect(isTabEnabled(task, "findings")).toBe(false);
    expect(isTabEnabled(task, "diff")).toBe(false);
    expect(isTabEnabled(makeTask({ stage: "code-review" }), "findings")).toBe(true);
  });

  it("says why the task waits", () => {
    const counts = { openQuestions: 2, blocking: 1, round: 1 };
    expect(gateBanner({ gate: "questions", mode: null }, counts).title).toBe(
      "2 questions need your decision",
    );
    const triage = gateBanner({ gate: "triage", mode: null }, counts);
    expect(triage.title).toBe("Fix round 1 paused for your triage");
    expect(triage.detail).toContain("start fix round 2");
  });
});

describe("findings", () => {
  it("gates on open Critical/High and force-fixed findings", () => {
    expect(isBlocking({ severity: "high", status: "open" })).toBe(true);
    expect(isBlocking({ severity: "high", status: "force-ignore" })).toBe(false);
    expect(isBlocking({ severity: "low", status: "force-fix" })).toBe(true);
    expect(isBlocking({ severity: "low", status: "open" })).toBe(false);
  });

  it("hides merged duplicates and sorts open, severe and recent first", () => {
    const low = finding({ severity: "low" });
    const fixedCritical = finding({ severity: "critical", status: "fixed" });
    const high = finding({ severity: "high", round: 1 });
    const merged = finding({ status: "merged", mergedIntoId: high.id });
    expect(visibleFindings([low, merged]).map((f) => f.id)).toEqual([low.id]);
    expect(sortFindings([low, fixedCritical, high]).map((f) => f.id)).toEqual([
      high.id,
      low.id,
      fixedCritical.id,
    ]);
  });

  it("formats locations", () => {
    expect(findingLocation({ file: "a.ts", lineStart: 3, lineEnd: 5 })).toBe("a.ts:3-5");
    expect(findingLocation({ file: "a.ts", lineStart: 3, lineEnd: 3 })).toBe("a.ts:3");
    expect(findingLocation({ file: null, lineStart: null, lineEnd: null })).toBeNull();
  });
});

describe("runs and steps", () => {
  const steps = [
    { id: "a", stage: "implement" as const, round: 0, status: "succeeded" as const },
    { id: "b", stage: "checks" as const, round: 0, status: "succeeded" as const },
    { id: "c", stage: "checks" as const, round: 1, status: "running" as const },
    { id: "d", stage: "code-review" as const, round: 1, status: "pending" as const },
  ];

  it("finds the round, the latest step of a stage and the step to show", () => {
    expect(currentRound(steps)).toBe(1);
    expect(currentRound([])).toBe(0);
    expect(latestStep(steps, "checks")?.id).toBe("c");
    expect(latestStep(steps, "summarize")).toBeUndefined();
    expect(defaultStepId(steps)).toBe("c");
    expect(defaultStepId([])).toBeNull();
  });

  it("finds the latest harness step of a stage, skipping agent steps", () => {
    const finish = [
      { id: "s", stage: "summarize" as const, agentId: "summarizer" },
      { id: "h1", stage: "summarize" as const, agentId: null },
      { id: "h2", stage: "summarize" as const, agentId: null },
      { id: "i", stage: "summarize" as const, agentId: "implementer" },
    ];
    expect(latestHarnessStep(finish, "summarize")?.id).toBe("h2");
    expect(latestHarnessStep(finish, "checks")).toBeUndefined();
  });

  it("extracts the delivery's rebase conflicts and ignores other events", () => {
    expect(
      deliveryConflicts([
        event(1, "delivery.conflict", { branch: "agent/t1", into: "main", files: ["a.ts"] }),
        event(2, "delivery.done", { action: "squash", detail: "abc" }),
        event(3, "delivery.conflict", { branch: "agent/t1", into: "main", files: ["b.tsx", 3] }),
      ]),
    ).toEqual([
      { branch: "agent/t1", into: "main", files: ["a.ts"] },
      { branch: "agent/t1", into: "main", files: ["b.tsx"] },
    ]);
    expect(deliveryConflicts([event(1, "message", { text: "hi" })])).toEqual([]);
  });

  it("counts the user's open grill questions", () => {
    const base = {
      taskId: "t1",
      runId: null,
      stepId: null,
      askedByAgentId: null,
      question: "?",
      createdAt: new Date(),
      answeredAt: null,
    };
    expect(
      openQuestionCount([
        { ...base, id: "q1", needsHuman: true, answer: null, answeredBy: null },
        { ...base, id: "q2", needsHuman: false, answer: null, answeredBy: null },
        { ...base, id: "q3", needsHuman: true, answer: "Yes", answeredBy: "user" },
      ]),
    ).toBe(1);
  });
});

describe("finish", () => {
  it("names each action exactly", () => {
    expect(
      deliveryActionCopy({ kind: "push-branch", branch: "feature/x", remote: "origin" }, 0),
    ).toEqual({ title: "Push branch", target: "feature/x → origin" });
    expect(
      deliveryActionCopy({ kind: "pr-review", url: "https://x/pull/1", findingIds: [] }, 1).title,
    ).toBe("Post review with 1 comment");
  });

  it("states how many actions the confirm sends", () => {
    expect(confirmLabel(0)).toBe("Keep local, mark done");
    expect(confirmLabel(1)).toBe("Confirm and send 1 action");
    expect(confirmLabel(3)).toBe("Confirm and send 3 actions");
  });
});

describe("new task form", () => {
  it("reads a Jira key or issue link", () => {
    expect(parseJiraInput(" abc-12 ")).toEqual({ key: "ABC-12", url: null });
    expect(parseJiraInput("https://acme.atlassian.net/browse/ABC-12")).toEqual({
      key: "ABC-12",
      url: "https://acme.atlassian.net",
    });
    expect(
      parseJiraInput("https://acme.atlassian.net/jira/software/projects/ABC?selectedIssue=ABC-7"),
    ).toEqual({ key: "ABC-7", url: "https://acme.atlassian.net" });
    expect(parseJiraInput("not a key")).toBeNull();
  });

  it("picks the Jira connection by host, or the only one", () => {
    const connections = [
      { id: "j1", kind: "jira" as const, baseUrl: "https://acme.atlassian.net" },
      { id: "g1", kind: "github" as const, baseUrl: "https://github.com" },
    ];
    expect(jiraConnectionId("https://acme.atlassian.net", connections)).toBe("j1");
    expect(jiraConnectionId("https://other.atlassian.net", connections)).toBeNull();
    expect(jiraConnectionId(null, connections)).toBe("j1");
    expect(jiraConnectionId(null, [...connections, { ...connections[0]!, id: "j2" }])).toBeNull();
  });

  it("lists the CLIs a task's agents run on", () => {
    const library = new Map([
      ["a", { cli: "claude" as const }],
      ["b", { cli: "copilot" as const }],
      ["c", { cli: "claude" as const }],
    ]);
    expect(agentClis({ planner: "a", codeReviewers: ["b", "c", "gone"] }, library)).toEqual([
      "claude",
      "copilot",
    ]);
  });
});

describe("stop and delete", () => {
  it("offers Stop only while queued or running", () => {
    expect(canStop(makeTask({ status: "queued" }))).toBe(true);
    expect(canStop(makeTask({ status: "running" }))).toBe(true);
    expect(canStop(makeTask({ status: "needs-you", gate: "finish" }))).toBe(false);
    expect(canStop(makeTask({ status: "interrupted" }))).toBe(false);
  });

  it("offers Archive only for done, unarchived tasks", () => {
    expect(canArchive(makeTask({ status: "done" }))).toBe(true);
    expect(
      canArchive(makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00Z") })),
    ).toBe(false);
    expect(canArchive(makeTask({ status: "failed" }))).toBe(false);
    expect(canArchive(makeTask({ status: "interrupted" }))).toBe(false);
    expect(canArchive(makeTask({ status: "running" }))).toBe(false);
    expect(canArchive(makeTask({ status: "needs-you", gate: "finish" }))).toBe(false);
  });

  it("tells a user stop apart from a shutdown or usage limit", () => {
    expect(isStoppedByUser(makeTask({ status: "interrupted", error: TASK_STOPPED_ERROR }))).toBe(
      true,
    );
    expect(isStoppedByUser(makeTask({ status: "interrupted" }))).toBe(false);
    expect(isStoppedByUser(makeTask({ status: "interrupted", error: "usage limit" }))).toBe(false);
  });

  it("blocks delete once something was delivered", () => {
    expect(deleteBlockedReason(makeTask())).toBeNull();
    expect(deleteBlockedReason(makeTask({ status: "done", deliveryTargets: [] }))).toBeNull();
    expect(
      deleteBlockedReason(makeTask({ status: "done", deliveryTargets: ["push-branch"] })),
    ).toMatch(/delivered/);
  });

  it("says what deleting removes", () => {
    const workspace = { branch: "agent/t1", worktreePath: "/wt" };
    expect(deleteTaskCopy(makeTask({ status: "failed", ...workspace }))).toBe(
      "Removes the worktree, the local branch agent/t1 and all run history.",
    );
    expect(deleteTaskCopy(makeTask({ status: "running", ...workspace }))).toMatch(
      /^Stops the task, then removes the worktree/,
    );
    expect(deleteTaskCopy(makeTask({ status: "queued" }))).toBe(
      "Stops the task, then removes the task and all run history.",
    );
    const pr = makeTask({
      status: "interrupted",
      origin: {
        kind: "github-pr",
        url: "https://github.com/acme/app/pull/7",
        owner: "acme",
        repo: "app",
        number: 7,
        connectionId: null,
      },
      mode: "review",
      branch: "fix-login",
      worktreePath: "/wt",
    });
    expect(deleteTaskCopy(pr)).toBe(
      "Removes the worktree and all run history. The PR branch fix-login stays.",
    );
  });
});
