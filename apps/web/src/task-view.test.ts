import {
  findingSchema,
  type DeliveryAction,
  type DeliveryPlan,
  type Finding,
  type PullRequestThread,
  type StepEvent,
} from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { TASK_STOPPED_ERROR } from "@blackwall/shared";
import {
  activeOverrides,
  agentClis,
  backlogAgentClis,
  canArchive,
  canCommentOnDiff,
  canDeleteFinding,
  canFixPrComments,
  canOverrideFinding,
  canStepThroughDiff,
  carryPicks,
  canStop,
  diffCommentsRunFixRound,
  finishBusy,
  deleteTaskCopy,
  isStoppedByUser,
  buildTranscript,
  checkRuns,
  checksSkipReason,
  ciBanner,
  confirmLabel,
  currentActivity,
  currentRound,
  defaultStepId,
  defaultTab,
  deliveryActionCopy,
  deliveryConflicts,
  diffStat,
  effectiveModel,
  findingLocation,
  gateBanner,
  initialTicks,
  hunkFindings,
  hunkThreads,
  isBlocking,
  isOutbound,
  isTabEnabled,
  jiraConnectionId,
  latestHarnessStep,
  latestStep,
  looksLikeDiff,
  MODEL_SOURCE_HINTS,
  modelTitle,
  openQuestionCount,
  parseDiff,
  originUrl,
  parseJiraInput,
  planApprovalComment,
  pullRequestUrl,
  sortFindings,
  splitHunks,
  stepModel,
  subagentStatus,
  TASK_TABS,
  toggleTick,
  toolTarget,
  unplacedThreads,
  visibleFindings,
  type DiffLine,
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

describe("splitHunks", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    " const c = 4;",
    "@@ -20,2 +20,3 @@",
    " x",
    "+y",
    " z",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 333..444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -4 +4 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  it("splits a file into hunks numbered per file, with their new-file lines and text", () => {
    const hunks = splitHunks(parseDiff(diff));
    expect(hunks.map((h) => [h.path, h.index, h.lineStart, h.lineEnd])).toEqual([
      ["src/a.ts", 0, 1, 3],
      ["src/a.ts", 1, 20, 22],
      ["src/b.ts", 0, 4, 4],
    ]);
    expect(hunks.map((h) => h.text)).toEqual([
      "@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n const c = 4;",
      "@@ -20,2 +20,3 @@\n x\n+y\n z",
      "@@ -4 +4 @@\n-old\n+new",
    ]);
  });

  it("takes the line a deletion-only hunk points at, and none for a deleted file", () => {
    const hunks = splitHunks(
      parseDiff(
        [
          "diff --git a/src/gone.ts b/src/gone.ts",
          "--- a/src/gone.ts",
          "+++ b/src/gone.ts",
          "@@ -5,2 +4,0 @@",
          "-one",
          "-two",
          "diff --git a/src/old.ts b/src/old.ts",
          "deleted file mode 100644",
          "--- a/src/old.ts",
          "+++ /dev/null",
          "@@ -1,2 +0,0 @@",
          "-gone",
          "-too",
        ].join("\n"),
      ),
    );
    expect(hunks.map((h) => [h.path, h.lineStart, h.lineEnd])).toEqual([
      ["src/gone.ts", 4, 4],
      ["src/old.ts", null, null],
    ]);
  });

  it("skips a binary file, which has no hunks", () => {
    const binary = [
      "diff --git a/img.png b/img.png",
      "index 1..2 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    expect(splitHunks(parseDiff(binary))).toEqual([]);
  });
});

describe("diff comments", () => {
  const prOrigin = {
    kind: "github-pr" as const,
    url: "https://github.com/acme/web/pull/1",
    owner: "acme",
    repo: "web",
    number: 1,
    connectionId: null,
  };

  it("lets the user comment on a work task waiting at finish, triage or escalation", () => {
    for (const gate of ["finish", "triage", "escalation"] as const) {
      expect(canCommentOnDiff(makeTask({ status: "needs-you", gate }))).toBe(true);
    }
  });

  it("does not offer comments at the grill-type gates", () => {
    for (const gate of ["questions", "plan-approval"] as const) {
      expect(canCommentOnDiff(makeTask({ status: "needs-you", gate }))).toBe(false);
    }
  });

  it("does not offer comments unless the task needs the user", () => {
    expect(canCommentOnDiff(makeTask({ status: "running", stage: "code-review" }))).toBe(false);
    expect(canCommentOnDiff(makeTask({ status: "done" }))).toBe(false);
  });

  const review = (patch: Parameters<typeof makeTask>[0] = {}) =>
    makeTask({ status: "needs-you", gate: "triage", mode: "review", origin: prOrigin, ...patch });

  it("lets the user comment on a Review PR task only at triage", () => {
    expect(canCommentOnDiff(review())).toBe(true);
    expect(canCommentOnDiff(review({ gate: "finish" }))).toBe(false);
    expect(canCommentOnDiff(review({ gate: "escalation" }))).toBe(false);
  });

  it("does not offer comments while delivering", () => {
    expect(
      canCommentOnDiff(makeTask({ status: "needs-you", gate: "finish", delivering: true })),
    ).toBe(false);
    expect(canCommentOnDiff(review({ delivering: true }))).toBe(false);
  });

  it("starts a fix round straight away at finish and escalation, not at triage", () => {
    expect(diffCommentsRunFixRound(makeTask({ gate: "finish" }))).toBe(true);
    expect(diffCommentsRunFixRound(makeTask({ gate: "escalation" }))).toBe(true);
    expect(diffCommentsRunFixRound(makeTask({ gate: "triage" }))).toBe(false);
  });

  it("never starts a fix round from a Review PR task's comments", () => {
    expect(diffCommentsRunFixRound(review())).toBe(false);
    expect(diffCommentsRunFixRound(review({ gate: "finish" }))).toBe(false);
  });

  it("lets the user delete unfixed findings at review triage only", () => {
    for (const status of ["open", "force-fix", "force-ignore"] as const) {
      expect(canDeleteFinding(review(), finding({ status }))).toBe(true);
    }
    for (const status of ["merged", "fixed"] as const) {
      expect(canDeleteFinding(review(), finding({ status }))).toBe(false);
    }
    expect(canDeleteFinding(review({ gate: "finish" }), finding())).toBe(false);
    expect(canDeleteFinding(review({ status: "running", gate: null }), finding())).toBe(false);
    expect(canDeleteFinding(review({ delivering: true }), finding())).toBe(false);
    expect(canDeleteFinding(makeTask({ status: "needs-you", gate: "triage" }), finding())).toBe(
      false,
    );
  });

  it("lets the user step through a Review PR task's diff at any time", () => {
    expect(canStepThroughDiff(review())).toBe(true);
    expect(canStepThroughDiff(review({ status: "running", gate: null }))).toBe(true);
    expect(canStepThroughDiff(review({ status: "queued", gate: null }))).toBe(true);
    expect(canStepThroughDiff(review({ status: "done", gate: null }))).toBe(true);
  });

  it("lets the user step through a work task's diff only when they can comment", () => {
    for (const task of [
      makeTask({ status: "needs-you", gate: "finish" }),
      makeTask({ status: "needs-you", gate: "plan-approval" }),
      makeTask({ status: "running", stage: "code-review" }),
      makeTask({ status: "needs-you", gate: "finish", delivering: true }),
    ]) {
      expect(canStepThroughDiff(task)).toBe(canCommentOnDiff(task));
    }
  });
});

describe("hunkFindings", () => {
  const hunk = { path: "src/a.ts", index: 1, lineStart: 20, lineEnd: 25 };

  it("keeps findings whose range overlaps the hunk's", () => {
    const inside = finding({ file: "src/a.ts", lineStart: 22, lineEnd: 23 });
    const across = finding({ file: "src/a.ts", lineStart: 18, lineEnd: 20 });
    const single = finding({ file: "src/a.ts", lineStart: 25 });
    const before = finding({ file: "src/a.ts", lineStart: 10, lineEnd: 19 });
    const after = finding({ file: "src/a.ts", lineStart: 26 });
    expect(hunkFindings(hunk, [inside, across, single, before, after]).map((f) => f.id)).toEqual([
      inside.id,
      across.id,
      single.id,
    ]);
  });

  it("puts a finding with no line on the file's first hunk only", () => {
    const noLine = finding({ file: "src/a.ts" });
    expect(hunkFindings({ ...hunk, index: 0 }, [noLine])).toEqual([noLine]);
    expect(hunkFindings(hunk, [noLine])).toEqual([]);
  });

  it("leaves out findings in other files and findings with no file", () => {
    expect(
      hunkFindings({ ...hunk, index: 0 }, [
        finding({ file: "src/b.ts", lineStart: 21 }),
        finding({ file: null }),
      ]),
    ).toEqual([]);
  });

  it("matches a deletion-only hunk on the line it points at", () => {
    const at = finding({ file: "src/a.ts", lineStart: 4 });
    expect(hunkFindings({ path: "src/a.ts", index: 0, lineStart: 4, lineEnd: 4 }, [at])).toEqual([
      at,
    ]);
    const deleted = { path: "src/a.ts", index: 1, lineStart: null, lineEnd: null };
    expect(hunkFindings(deleted, [at])).toEqual([]);
  });

  it("sorts the most severe first", () => {
    const low = finding({ file: "src/a.ts", lineStart: 21, severity: "low" });
    const critical = finding({ file: "src/a.ts", lineStart: 21, severity: "critical" });
    expect(hunkFindings(hunk, [low, critical]).map((f) => f.id)).toEqual([critical.id, low.id]);
  });

  it("normalizes the finding's path", () => {
    for (const file of ["./src/a.ts", "/src/a.ts", "src\\a.ts", " src/a.ts "]) {
      expect(hunkFindings(hunk, [finding({ file, lineStart: 21 })])).toHaveLength(1);
    }
  });
});

describe("hunkThreads", () => {
  let threadSeq = 0;
  function thread(overrides: Partial<PullRequestThread> = {}): PullRequestThread {
    threadSeq += 1;
    return {
      id: threadSeq,
      path: "src/a.ts",
      line: null,
      startLine: null,
      side: "RIGHT",
      outdated: false,
      url: null,
      comments: [],
      ...overrides,
    };
  }
  const lines = (...spec: [DiffLine["kind"], number | null][]): DiffLine[] =>
    spec.map(([kind, line]) => ({ kind, line, text: "" }));
  // @@ -10,3 +10,3 @@: ctx 10, del 11 (old), add 11 (new), ctx 12
  const hunk = {
    path: "src/a.ts",
    index: 1,
    lines: lines(["hunk", null], ["ctx", 10], ["del", 11], ["add", 11], ["ctx", 12]),
  };

  it("places a RIGHT thread on an added or context line", () => {
    const onAdd = thread({ line: 11 });
    const onCtx = thread({ line: 12 });
    const elsewhere = thread({ line: 30 });
    expect(hunkThreads(hunk, [onAdd, onCtx, elsewhere])).toEqual([onAdd, onCtx]);
  });

  it("places a LEFT thread on a deleted line only", () => {
    const left = thread({ line: 11, side: "LEFT" });
    const leftOnCtx = thread({ line: 10, side: "LEFT" });
    expect(hunkThreads(hunk, [left, leftOnCtx])).toEqual([left]);
    const addOnly = { ...hunk, lines: lines(["hunk", null], ["add", 11]) };
    expect(hunkThreads(addOnly, [left])).toEqual([]);
  });

  it("places a multi-line thread when any of its lines is on the hunk", () => {
    const range = thread({ startLine: 5, line: 10 });
    expect(hunkThreads(hunk, [range])).toEqual([range]);
    expect(hunkThreads(hunk, [thread({ startLine: 2, line: 9 })])).toEqual([]);
  });

  it("puts an outdated thread on its file's first hunk only", () => {
    const outdated = thread({ outdated: true });
    expect(hunkThreads({ ...hunk, index: 0 }, [outdated])).toEqual([outdated]);
    expect(hunkThreads(hunk, [outdated])).toEqual([]);
  });

  it("leaves out threads on other files", () => {
    expect(hunkThreads(hunk, [thread({ path: "src/b.ts", line: 11 })])).toEqual([]);
  });

  it("counts the threads that land on no hunk", () => {
    const placed = thread({ line: 11 });
    const outside = thread({ line: 40 });
    const otherFile = thread({ path: "src/b.ts", line: 11 });
    expect(unplacedThreads([hunk], [placed, outside, otherFile])).toBe(2);
    expect(unplacedThreads([hunk], [placed])).toBe(0);
  });
});

describe("canOverrideFinding", () => {
  it("lets the user force fix / force ignore in a work task", () => {
    expect(canOverrideFinding({ mode: "work" })).toBe(true);
  });

  it("leaves a review task's findings to the picks at the end", () => {
    expect(canOverrideFinding({ mode: "review" })).toBe(false);
  });
});

describe("canFixPrComments", () => {
  const opened = makeTask({ status: "done", deliveryTargets: ["push-branch", "open-pr"] });

  it("offers a done work task whose delivery opened a PR", () => {
    expect(canFixPrComments(opened)).toBe(true);
  });

  it("refuses a task not done, a review task and one without an opened PR", () => {
    expect(canFixPrComments({ ...opened, status: "needs-you" })).toBe(false);
    expect(canFixPrComments({ ...opened, mode: "review" })).toBe(false);
    expect(canFixPrComments({ ...opened, deliveryTargets: ["push-branch"] })).toBe(false);
  });
});

describe("carryPicks", () => {
  const previous = { offered: new Set(["a", "b", "c"]), picked: new Set(["a", "c"]) };

  it("picks every offered finding the first time", () => {
    expect(carryPicks(undefined, ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("keeps earlier picks and unpicks across a refetch", () => {
    const carried = carryPicks(previous, ["a", "b", "c"]);
    expect(carried.has("a")).toBe(true);
    expect(carried.has("b")).toBe(false);
    expect(carried.has("c")).toBe(true);
  });

  it("picks newly offered findings, such as a new hunk comment", () => {
    expect(carryPicks(previous, ["a", "b", "c", "d"])).toEqual(new Set(["a", "c", "d"]));
  });

  it("drops findings no longer offered, such as a deleted one", () => {
    expect(carryPicks(previous, ["b", "c"])).toEqual(new Set(["c"]));
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

  it("scopes to the step's own agent or one sub-agent when asked", () => {
    const events = [
      event(1, "tool-call-start", {
        id: "t1",
        name: "Agent",
        input: { description: "Run the tests" },
      }),
      event(2, "subagent-start", { id: "t1", agentType: "blackwall-worker", description: null }),
      event(3, "tool-call-start", {
        id: "c2",
        name: "Bash",
        input: { command: "pnpm test" },
        parentId: "t1",
      }),
    ];
    expect(currentActivity(events)).toBe("Bash pnpm test");
    expect(currentActivity(events, null)).toBe("Agent Run the tests");
    expect(currentActivity(events, "t1")).toBe("Bash pnpm test");
    expect(currentActivity(events, "t9")).toBeNull();
  });
});

describe("stepModel", () => {
  it("is null without a reported model", () => {
    expect(stepModel([])).toBeNull();
    expect(stepModel([event(1, "session", { sessionId: "x" })])).toBeNull();
  });

  it("returns the model from the session event", () => {
    expect(stepModel([event(1, "session", { sessionId: "x", model: "claude-opus-5-5" })])).toBe(
      "claude-opus-5-5",
    );
  });

  it("takes the latest session after a resume", () => {
    expect(
      stepModel([
        event(1, "session", { sessionId: "x", model: "claude-opus-5-5" }),
        event(2, "text", { text: "hi" }),
        event(3, "session", { sessionId: "y", model: "claude-haiku-5-5" }),
      ]),
    ).toBe("claude-haiku-5-5");
  });

  it("ignores models outside session events", () => {
    expect(stepModel([event(1, "text", { text: "hi", model: "gpt" })])).toBeNull();
  });

  it("ignores non-string and empty models", () => {
    expect(stepModel([event(1, "session", { sessionId: "x", model: 42 })])).toBeNull();
    expect(stepModel([event(1, "session", { sessionId: "x", model: "" })])).toBeNull();
  });
});

describe("effectiveModel", () => {
  const reported = [event(1, "session", { sessionId: "x", model: "claude-opus-5-5" })];

  it("prefers the model the CLI reported over the agent's", () => {
    expect(effectiveModel(reported, { models: { claude: "sonnet" } }, "claude")).toEqual({
      model: "claude-opus-5-5",
      source: "reported",
    });
  });

  it("falls back to the agent's model before the CLI reports one", () => {
    expect(
      effectiveModel(
        [event(1, "session", { sessionId: "x" })],
        { models: { claude: "sonnet" } },
        "claude",
      ),
    ).toEqual({ model: "sonnet", source: "configured" });
  });

  it("ignores a model set for another CLI than the step's", () => {
    expect(effectiveModel([], { models: { claude: "sonnet" } }, "copilot")).toEqual({
      model: null,
      source: "default",
    });
  });

  it("is Auto when neither names a model", () => {
    const auto = { model: null, source: "default" };
    expect(effectiveModel([], { models: {} }, "claude")).toEqual(auto);
    expect(effectiveModel(undefined, undefined, null)).toEqual(auto);
    expect(effectiveModel(undefined, { models: { claude: "sonnet" } }, "claude")).toEqual({
      model: "sonnet",
      source: "configured",
    });
  });

  it("uses the later session event that carries a model", () => {
    expect(
      effectiveModel(
        [
          event(1, "session", { sessionId: "x" }),
          event(2, "session", { sessionId: "x", model: "claude-sonnet-5.5" }),
        ],
        { models: {} },
        "copilot",
      ),
    ).toEqual({ model: "claude-sonnet-5.5", source: "reported" });
  });
});

describe("modelTitle", () => {
  it("prepends the model to the source hint", () => {
    expect(modelTitle({ model: "sonnet", source: "configured" })).toBe(
      `sonnet — ${MODEL_SOURCE_HINTS.configured}`,
    );
  });

  it("is only the hint for Auto", () => {
    expect(modelTitle({ model: null, source: "default" })).toBe(MODEL_SOURCE_HINTS.default);
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

  it("reads why the checks were skipped", () => {
    expect(
      checksSkipReason([event(1, "checks.skipped", { reason: "no-changes", files: [] })]),
    ).toBe("no-changes");
    expect(
      checksSkipReason([event(1, "checks.skipped", { reason: "docs-only", files: ["a.md"] })]),
    ).toBe("docs-only");
    expect(checksSkipReason([event(1, "check.started", { command: "pnpm test" })])).toBeNull();
    expect(checksSkipReason([])).toBeNull();
  });

  it("notes skipped checks in the transcript", () => {
    const items = buildTranscript([
      event(1, "checks.skipped", { reason: "no-changes", files: [] }),
      event(2, "checks.skipped", { reason: "docs-only", files: ["a.md", "docs/b.png"] }),
    ]);
    expect(items).toEqual([
      { kind: "note", key: "s1:1", text: "Skipped the checks: this branch changes no files" },
      {
        kind: "note",
        key: "s1:2",
        text: "Skipped the checks: this branch changes only documentation (2 files)",
      },
    ]);
  });

  it("nests a sub-agent's messages and tool calls under its Agent call", () => {
    const input = {
      subagent_type: "blackwall-worker",
      description: "Read a.txt",
      prompt: "Read it",
    };
    const items = buildTranscript([
      event(1, "message", { text: "Handing off." }),
      event(2, "tool-call-start", { id: "t1", name: "Agent", input }),
      event(3, "subagent-start", { id: "t1", agentType: "blackwall-worker", description: null }),
      event(4, "message", { text: "Reading.", parentId: "t1" }),
      event(5, "tool-call-start", {
        id: "c1",
        name: "Read",
        input: { file_path: "a.txt" },
        parentId: "t1",
      }),
      event(6, "tool-call-end", { id: "c1", output: "hello", isError: false, parentId: "t1" }),
      event(7, "tool-call-end", { id: "t1", output: "It says hello.", isError: false }),
      event(8, "subagent-end", { id: "t1" }),
      event(9, "message", { text: "Done." }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["message", "subagent", "message"]);
    expect(items[1]).toEqual({
      kind: "subagent",
      key: "s1:2",
      id: "t1",
      name: "Agent",
      target: "Read a.txt",
      agentType: "blackwall-worker",
      description: "Read a.txt",
      input,
      output: "It says hello.",
      isError: false,
      items: [
        { kind: "message", key: "s1:4", text: "Reading." },
        {
          kind: "tool",
          key: "s1:5",
          name: "Read",
          target: "a.txt",
          input: { file_path: "a.txt" },
          output: "hello",
          isError: false,
        },
      ],
    });
  });

  it("groups by parentId without a subagent-start, naming the group from the call's input", () => {
    const items = buildTranscript([
      event(1, "tool-call-start", {
        id: "t1",
        name: "Agent",
        input: { subagent_type: "Explore", description: "Find tests" },
      }),
      event(2, "message", { text: "Looking.", parentId: "t1" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      agentType: "Explore",
      description: "Find tests",
      output: null,
      items: [{ kind: "message", text: "Looking." }],
    });
  });

  it("keeps interleaved sub-agents' children apart", () => {
    const items = buildTranscript([
      event(1, "tool-call-start", { id: "t1", name: "Agent", input: { description: "One" } }),
      event(2, "tool-call-start", { id: "t2", name: "Agent", input: { description: "Two" } }),
      event(3, "message", { text: "first", parentId: "t1" }),
      event(4, "message", { text: "second", parentId: "t2" }),
      event(5, "message", { text: "first again", parentId: "t1" }),
    ]);
    const texts = items.map((item) =>
      item.kind === "subagent"
        ? item.items.map((child) => (child.kind === "message" ? child.text : ""))
        : [],
    );
    expect(texts).toEqual([["first", "first again"], ["second"]]);
  });

  it("keeps events whose parent never showed up at the top level", () => {
    const items = buildTranscript([event(1, "message", { text: "Orphan.", parentId: "t9" })]);
    expect(items).toEqual([{ kind: "message", key: "s1:1", text: "Orphan." }]);
  });

  it("derives a sub-agent's status from its call's result", () => {
    expect(subagentStatus({ output: null, isError: false }, true)).toBe("running");
    expect(subagentStatus({ output: "ok", isError: false }, true)).toBe("done");
    expect(subagentStatus({ output: "boom", isError: true }, false)).toBe("failed");
    expect(subagentStatus({ output: null, isError: false }, false)).toBe("stopped");
  });

  it("names a tool call by its file, command or pattern", () => {
    expect(toolTarget({ pattern: "TODO", path: "src" })).toBe("src");
    expect(toolTarget({ command: "git status\ngit log" })).toBe("git status");
    expect(toolTarget({})).toBe("");
    expect(toolTarget({ a: 1 })).toBe('{"a":1}');
  });
});

describe("ciBanner", () => {
  const run = (name: string, state: "passed" | "failed") => ({
    name,
    kind: "check-run" as const,
    id: name.length,
    state,
    conclusion: state === "failed" ? "failure" : "success",
    url: null,
  });

  it("titles the failure with the short sha and counts the failed checks", () => {
    const banner = ciBanner({
      sha: "abc1234def5678",
      checks: [run("unit", "failed"), run("e2e", "failed"), run("lint", "passed")],
    });
    expect(banner.title).toBe("CI failed on abc1234");
    expect(banner.detail).toMatch(/^2 checks failed\. /);
  });

  it("uses the singular for one failed check", () => {
    const banner = ciBanner({ sha: "abc1234def5678", checks: [run("unit", "failed")] });
    expect(banner.detail).toMatch(/^1 check failed\. /);
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

  it("enables Artifacts with a worktree, except on Review PR tasks", () => {
    expect(TASK_TABS.indexOf("artifacts")).toBe(TASK_TABS.indexOf("diff") + 1);
    expect(isTabEnabled(makeTask({ worktreePath: null }), "artifacts")).toBe(false);
    expect(isTabEnabled(makeTask({ worktreePath: "/wt" }), "artifacts")).toBe(true);
    const review = makeTask({
      worktreePath: "/wt",
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
    expect(isTabEnabled(review, "artifacts")).toBe(false);
  });

  it("says why the task waits", () => {
    const counts = { openQuestions: 2, blocking: 1, round: 1 };
    expect(gateBanner({ gate: "questions", mode: null, delivering: false }, counts).title).toBe(
      "2 questions need your decision",
    );
    const triage = gateBanner({ gate: "triage", mode: null, delivering: false }, counts);
    expect(triage.title).toBe("Fix round 1 paused for your triage");
    expect(triage.detail).toContain("start fix round 2");
  });

  it("says a delivering task is finishing", () => {
    const counts = { openQuestions: 0, blocking: 0, round: 1 };
    const finishing = gateBanner({ gate: "finish", mode: null, delivering: true }, counts);
    expect(finishing.title).toBe("Finishing");
    expect(finishing.detail).toContain("actions you confirmed");
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

  it("finds the pull request a delivery opened", () => {
    const url = "https://github.com/acme/app/pull/12";
    expect(
      pullRequestUrl([
        event(1, "delivery.done", { action: "push-branch", detail: "agent/t1" }),
        event(2, "delivery.done", { action: "open-pr", detail: url }),
        event(3, "delivery.done", { action: "issue-comment", detail: "https://x.test/c/1" }),
      ]),
    ).toBe(url);
  });

  it("ignores other delivery actions and other events when finding the pull request", () => {
    expect(
      pullRequestUrl([
        event(1, "delivery.done", { action: "push-branch", detail: "https://x.test/b" }),
        event(2, "delivery.done", { action: "issue-comment", detail: "https://x.test/c" }),
        event(3, "message", { action: "open-pr", detail: "https://x.test/p" }),
      ]),
    ).toBeUndefined();
  });

  it("takes the last pull request a delivery opened", () => {
    expect(
      pullRequestUrl([
        event(1, "delivery.done", { action: "open-pr", detail: "https://x.test/pull/1" }),
        event(2, "delivery.done", { action: "open-pr", detail: "https://x.test/pull/2" }),
      ]),
    ).toBe("https://x.test/pull/2");
  });

  it("has no pull request without a valid link", () => {
    expect(pullRequestUrl([])).toBeUndefined();
    expect(
      pullRequestUrl([event(1, "delivery.done", { action: "open-pr", detail: "" })]),
    ).toBeUndefined();
    expect(
      pullRequestUrl([event(1, "delivery.done", { action: "open-pr", detail: "abc123" })]),
    ).toBeUndefined();
    expect(
      pullRequestUrl([event(1, "delivery.done", { action: "open-pr", detail: "javascript:x" })]),
    ).toBeUndefined();
    expect(pullRequestUrl([event(1, "delivery.done", { action: "open-pr" })])).toBeUndefined();
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

describe("finish ticks", () => {
  const merge: DeliveryAction = { kind: "merge-main", branch: "agent/t1", into: "main" };
  const push: DeliveryAction = { kind: "push-branch", branch: "feat/x", remote: "origin" };
  const pr: DeliveryAction = {
    kind: "open-pr",
    host: "github.com",
    owner: "acme",
    repo: "app",
    head: "feat/x",
    base: "main",
    title: "X",
    body: "B",
  };
  const comment: DeliveryAction = { kind: "jira-comment", key: "ABC-1", url: null, body: "B" };
  const plan = (actions: DeliveryAction[], completed: DeliveryPlan["completed"] = []) => ({
    actions,
    squash: null,
    completed,
  });
  const all = ["merge-main", "push-branch", "open-pr"] as const;

  it("ticks the local merge over the PR route, and everything else", () => {
    expect([...initialTicks(plan([merge, push, pr]))]).toEqual(["merge-main"]);
    expect([...initialTicks(plan([push, pr, comment]))]).toEqual([
      "push-branch",
      "open-pr",
      "jira-comment",
    ]);
    expect([...initialTicks(plan([push, pr], ["push-branch"]))]).toEqual(["open-pr"]);
  });

  it("keeps the local merge and the PR route exclusive", () => {
    expect([...toggleTick(new Set(["merge-main"]), "push-branch", true, all)]).toEqual([
      "push-branch",
    ]);
    expect([...toggleTick(new Set(["merge-main"]), "open-pr", true, all)].sort()).toEqual([
      "open-pr",
      "push-branch",
    ]);
    expect([...toggleTick(new Set(["push-branch", "open-pr"]), "merge-main", true, all)]).toEqual([
      "merge-main",
    ]);
    expect([...toggleTick(new Set(["push-branch", "open-pr"]), "push-branch", false, all)]).toEqual(
      [],
    );
    expect([...toggleTick(new Set(["push-branch", "open-pr"]), "open-pr", false, all)]).toEqual([
      "push-branch",
    ]);
    // A PR whose push already went through ticks no push.
    expect([...toggleTick(new Set(), "open-pr", true, ["open-pr"])]).toEqual(["open-pr"]);
  });
});

describe("finish", () => {
  it("names each action exactly", () => {
    expect(
      deliveryActionCopy({ kind: "push-branch", branch: "feature/x", remote: "origin" }, 0),
    ).toEqual({ title: "Push branch", target: "feature/x → origin" });
    expect(
      deliveryActionCopy(
        { kind: "push-branch", branch: "feat/x", remote: "origin", from: "agent/t1" },
        0,
      ),
    ).toEqual({ title: "Push branch", target: "agent/t1 as feat/x → origin" });
    expect(
      deliveryActionCopy({ kind: "pr-review", url: "https://x/pull/1", findingIds: [] }, 1).title,
    ).toBe("Post review with 1 comment");
    const review: DeliveryAction = { kind: "pr-review", url: "https://x/pull/1", findingIds: [] };
    expect(deliveryActionCopy(review, 0, true)).toEqual({
      title: "Approve the pull request",
      target: "https://x/pull/1",
    });
    expect(deliveryActionCopy(review, 1, true).title).toBe("Approve with 1 comment");
    expect(deliveryActionCopy(review, 2, true).title).toBe("Approve with 2 comments");
    expect(
      deliveryActionCopy({ kind: "issue-comment", url: "https://x/issues/7", body: "Done" }, 0),
    ).toEqual({ title: "Comment on the issue", target: "https://x/issues/7", body: "Done" });
  });

  it("names the follow-ups to create and their repos, and keeps them local", () => {
    const item = (title: string, repoName: string) => ({
      title,
      description: "d",
      repoId: repoName,
      repoName,
    });
    const action = {
      kind: "create-tasks" as const,
      items: [item("A", "app"), item("B", "api"), item("C", "app")],
    };
    expect(deliveryActionCopy(action, 2)).toEqual({
      title: "Create 2 follow-up tasks",
      target: "waiting in the backlog of app, api",
    });
    expect(deliveryActionCopy(action, 1).title).toBe("Create 1 follow-up task");
    expect(isOutbound(action)).toBe(false);
    expect(isOutbound({ kind: "merge-main", branch: "agent/x", into: "main" })).toBe(false);
    expect(isOutbound({ kind: "issue-comment", url: "https://x/issues/7", body: "Done" })).toBe(
      true,
    );
  });

  it("states how many actions the confirm sends", () => {
    expect(confirmLabel(0)).toBe("Keep local, mark done");
    expect(confirmLabel(1)).toBe("Confirm and send 1 action");
    expect(confirmLabel(3)).toBe("Confirm and send 3 actions");
  });
});

describe("finishBusy", () => {
  it("is busy while the task is delivering", () => {
    expect(finishBusy({ delivering: true }, false)).toBe(true);
  });

  it("is busy while the answer is in flight", () => {
    expect(finishBusy({ delivering: false }, true)).toBe(true);
  });

  it("is idle otherwise", () => {
    expect(finishBusy({ delivering: false }, false)).toBe(false);
  });
});

describe("GitHub issue tasks", () => {
  const origin = {
    kind: "github-issue" as const,
    url: "https://github.com/acme/web/issues/7",
    owner: "acme",
    repo: "web",
    number: 7,
    connectionId: null,
  };

  it("links the issue", () => {
    expect(originUrl(makeTask({ origin }), [])).toBe("https://github.com/acme/web/issues/7");
  });

  it("drafts the plan approval comment as one sentence with the branch", () => {
    expect(planApprovalComment({ branch: "feature/7-export" })).toBe(
      "The plan is approved. Implementation is starting on branch `feature/7-export`.",
    );
    expect(planApprovalComment({ branch: null })).toBe(
      "The plan is approved. Implementation is starting.",
    );
  });

  it("shows the plan approval comment as a note in the transcript", () => {
    expect(
      buildTranscript([
        event(1, "issue.commented", {
          url: "https://github.com/acme/web/issues/7#c1",
          at: "plan-approval",
        }),
      ]),
    ).toEqual([
      {
        kind: "note",
        key: "s1:1",
        text: "Commented on the issue: https://github.com/acme/web/issues/7#c1",
      },
    ]);
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
    const task = {
      agents: { planner: "a", codeReviewers: ["b", "c"] },
      cli: "claude" as const,
      agentClis: { b: "copilot" as const },
    };
    expect(agentClis(task)).toEqual(["claude", "copilot"]);
    expect(agentClis({ ...task, agentClis: {} })).toEqual(["claude"]);
    expect(backlogAgentClis({ planner: "a" }, { a: "claude" }, "copilot")).toEqual(["claude"]);
    expect(backlogAgentClis({}, {}, "copilot")).toEqual([]);
  });

  it("keeps only CLI overrides for chosen agents that differ from the default", () => {
    const stored = { a: "copilot" as const, b: "claude" as const, gone: "copilot" as const };
    expect(activeOverrides(stored, "claude", ["a", "b"])).toEqual({ a: "copilot" });
    // On a Copilot repo, a's choice equals the default and b's becomes active.
    expect(activeOverrides(stored, "copilot", ["a", "b"])).toEqual({ b: "claude" });
    // Switching back to the first repo brings a's stored choice back.
    expect(activeOverrides(stored, "claude", ["a", "b"])).toEqual({ a: "copilot" });
    expect(activeOverrides(stored, "claude", ["b"])).toEqual({});
  });
});

describe("stop and delete", () => {
  it("offers Stop while queued, running or waiting at a gate", () => {
    expect(canStop(makeTask({ status: "queued" }))).toBe(true);
    expect(canStop(makeTask({ status: "running" }))).toBe(true);
    expect(canStop(makeTask({ status: "needs-you", gate: "finish" }))).toBe(true);
    expect(canStop(makeTask({ status: "needs-you", gate: "questions" }))).toBe(true);
    expect(canStop(makeTask({ status: "needs-you", gate: "finish", delivering: true }))).toBe(
      false,
    );
    expect(canStop(makeTask({ status: "interrupted" }))).toBe(false);
    expect(canStop(makeTask({ status: "done" }))).toBe(false);
  });

  it("offers Archive for done, or delivered and stopped, unarchived tasks", () => {
    expect(canArchive(makeTask({ status: "done" }))).toBe(true);
    expect(
      canArchive(makeTask({ status: "done", archivedAt: new Date("2026-10-08T12:00:00Z") })),
    ).toBe(false);
    expect(canArchive(makeTask({ status: "failed" }))).toBe(false);
    expect(canArchive(makeTask({ status: "interrupted" }))).toBe(false);
    expect(canArchive(makeTask({ status: "running" }))).toBe(false);
    expect(canArchive(makeTask({ status: "needs-you", gate: "finish" }))).toBe(false);
    const delivered = { deliveryTargets: ["push-branch" as const] };
    expect(canArchive(makeTask({ status: "failed", ...delivered }))).toBe(true);
    expect(canArchive(makeTask({ status: "interrupted", ...delivered }))).toBe(true);
    expect(
      canArchive(
        makeTask({ status: "failed", ...delivered, archivedAt: new Date("2026-10-08T12:00:00Z") }),
      ),
    ).toBe(false);
    expect(canArchive(makeTask({ status: "running", ...delivered }))).toBe(false);
  });

  it("tells a user stop apart from a shutdown or usage limit", () => {
    expect(isStoppedByUser(makeTask({ status: "interrupted", error: TASK_STOPPED_ERROR }))).toBe(
      true,
    );
    expect(isStoppedByUser(makeTask({ status: "interrupted" }))).toBe(false);
    expect(isStoppedByUser(makeTask({ status: "interrupted", error: "usage limit" }))).toBe(false);
  });

  it("says a delivered task keeps its branch and what it sent", () => {
    const delivered = { deliveryTargets: ["open-pr" as const] };
    expect(
      deleteTaskCopy(
        makeTask({ status: "failed", ...delivered, branch: "agent/t1", worktreePath: "/wt" }),
      ),
    ).toBe(
      "Removes the worktree and all run history. The branch agent/t1 stays, and so does what it delivered (pushed branch, pull request, comments).",
    );
    expect(deleteTaskCopy(makeTask({ status: "done", ...delivered }))).toBe(
      "Removes the task and all run history. What it delivered stays.",
    );
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
