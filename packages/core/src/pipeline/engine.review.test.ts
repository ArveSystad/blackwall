import { MAX_FIX_ROUNDS, type ReviewFinding } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindingNotFoundError, TaskNotFoundError, TaskStateError } from "./engine.js";
import { postableFindings } from "./delivery.js";
import type { PrHeadSync, WorkspaceArchiver } from "./workspace.js";
import { InvalidGateResponseError } from "./transitions.js";
import { diffCommentFinding, type ReviewGit } from "./stages.js";
import {
  closeEngineTest,
  openEngineTest,
  fakeArchiver,
  createDefaultStages,
  highFinding,
  type Harness,
  harness,
  seedTask,
  task,
  settle,
  prOrigin,
  stepsOf,
  dir,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("diff comment findings", () => {
  const comment = {
    file: "src/a.ts",
    lineStart: 3,
    lineEnd: null,
    hunk: "@@ -1 +3 @@\n+x",
    body: "  Use a constant\nThe magic number repeats.  ",
  };

  it("titles the finding with the comment's first line and explains it with the hunk", () => {
    const seeded = seedTask();
    expect(diffCommentFinding(seeded, "run-1", 2, comment, "work")).toEqual({
      taskId: seeded.id,
      runId: "run-1",
      stepId: null,
      reviewerAgentId: null,
      severity: "high",
      tags: [],
      file: "src/a.ts",
      lineStart: 3,
      lineEnd: null,
      title: "Use a constant",
      explanation: "Use a constant\nThe magic number repeats.\n\n~~~~diff\n@@ -1 +3 @@\n+x\n~~~~",
      suggestedFix: null,
      status: "force-fix",
      round: 2,
    });
  });

  it("leaves a review task's comment open and explains it with the comment alone", () => {
    const seeded = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/x" });
    expect(diffCommentFinding(seeded, "run-1", 0, comment, "review")).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      severity: "high",
      title: "Use a constant",
      explanation: "Use a constant\nThe magic number repeats.",
      status: "open",
    });
  });

  it("cuts a long first line to 80 characters", () => {
    const seeded = seedTask();
    const titled = (body: string) =>
      diffCommentFinding(seeded, "run-1", 0, { ...comment, body }, "work").title;
    expect(titled("a".repeat(80))).toBe("a".repeat(80));
    const long = titled("word ".repeat(30));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("code review panel and triage", () => {
  const lowFinding: ReviewFinding = {
    severity: "low",
    tags: ["spelling"],
    file: "src/login.ts",
    lineStart: 10,
    lineEnd: 10,
    title: "Typo in error message",
    explanation: "Password is misspelled.",
    suggestedFix: "Fix the spelling",
  };

  async function approved(h: Harness, patch: Parameters<typeof seedTask>[0] = {}) {
    const seeded = seedTask(patch);
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    return seeded;
  }

  const afterApproval = (h: Harness) =>
    h.calls.slice(h.calls.findIndex((c) => c.stage === "implement")).map((c) => c.stage);

  it("merges the panel's duplicate findings into one", async () => {
    let review = 0;
    const h = harness((stage) => {
      if (stage !== "code-review") return {};
      review++;
      if (review === 1) return { structured: { findings: [highFinding] } };
      if (review === 2) {
        return {
          structured: {
            findings: [
              {
                ...highFinding,
                severity: "critical",
                tags: ["security"],
                title: "Loose password comparison with ==",
                explanation: "An empty string equals a missing password.",
                lineStart: 4,
                lineEnd: 6,
              },
              lowFinding,
            ],
          },
        };
      }
      return { structured: { findings: [] } };
    });
    const seeded = await approved(h);

    const findings = r.findings.listByTask(seeded.id);
    const [duplicate, primary, low] = findings;
    expect(findings.map((f) => f.status)).toEqual(["merged", "fixed", "open"]);
    expect(duplicate!.mergedIntoId).toBe(primary!.id);
    // The most severe report leads; the merge keeps every tag and the whole range.
    expect(primary).toMatchObject({
      title: "Loose password comparison with ==",
      severity: "critical",
      tags: ["security", "correctness"],
      lineStart: 3,
      lineEnd: 6,
    });
    expect(primary!.explanation).toContain("Also reported:\n- Password compared with ==");
    expect(low).toMatchObject({ severity: "low", status: "open" });
    // One fix round for the one merged blocker; the low finding goes to the summary.
    expect(afterApproval(h)).toEqual([
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const fix = h.calls.filter((c) => c.stage === "implement")[1]!.options.prompt;
    expect(fix).toContain("Loose password comparison");
    expect(fix).not.toContain("Typo in error message");
    expect(h.calls.at(-1)!.options.prompt).toContain("Typo in error message");
  });

  it("stops gating on a force-ignored blocker, even when a reviewer reports it again", async () => {
    let taskId = "";
    let implementCalls = 0;
    const h: Harness = harness((stage) => {
      if (stage === "code-review") return { structured: { findings: [highFinding] } };
      // The user ignores the blocker while the first fix round runs.
      if (stage === "implement" && ++implementCalls === 2) {
        const blocker = r.findings
          .listByTask(taskId)
          .find((f) => f.status === "force-fix" || f.status === "open");
        h.engine.overrideFinding(taskId, blocker!.id, { status: "force-ignore" });
      }
      return {};
    });
    const seeded = seedTask();
    taskId = seeded.id;
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    // The override survives the round, and the re-reports fold into it instead of gating.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(afterApproval(h)).toEqual([
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const findings = r.findings.listByTask(seeded.id);
    const ignored = findings.filter((f) => f.status === "force-ignore");
    expect(ignored).toHaveLength(1);
    expect(findings.filter((f) => f.status !== "force-ignore")).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({ status: "merged", mergedIntoId: ignored[0]!.id }),
      ),
    );
    // The second round's reviewers were told not to report it again.
    const lastReview = h.calls.filter((c) => c.stage === "code-review").at(-1)!.options.prompt;
    expect(lastReview).toContain("Findings the user chose to ignore");
    expect(lastReview).toContain("Do not report these again");
    expect(h.calls.at(-1)!.options.prompt).toContain("Findings the user chose to ignore");
  });

  it("skips the fix round when the user ignores every blocker at a paused triage", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
        : {},
    );
    const seeded = await approved(h, { triageMode: "pause" });
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const [blocker] = r.findings.listByTask(seeded.id);
    const ignored = h.engine.overrideFinding(seeded.id, blocker!.id, { status: "force-ignore" });
    expect(ignored.status).toBe("force-ignore");
    expect(h.events).toContainEqual({ type: "finding.upserted", payload: { finding: ignored } });

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("fixes a force-fixed low finding in one more round from the final triage", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);
    // Low findings never gate: straight to the summary.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);

    // Force-fixing at the finish gate starts the fix round straight away.
    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    // A free slot picks the queued task up at once.
    expect(task(seeded.id)).toMatchObject({ status: "running", gate: null, stage: "implement" });

    await settle(h.engine);
    const fixes = h.calls.filter((c) => c.stage === "implement");
    expect(fixes).toHaveLength(2);
    expect(fixes[1]!.options.prompt).toContain("Typo in error message");
    expect(r.findings.get(low!.id)!.status).toBe("fixed");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    await h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    expect(h.delivered).toEqual([seeded.id]);
  });

  it("runs a fix round before finish for a finding force-fixed during Summarize", async () => {
    let reviews = 0;
    let summaries = 0;
    let taskId = "";
    const h: Harness = harness((stage) => {
      if (stage === "code-review") {
        return { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } };
      }
      // The user force-fixes the Low finding while the first summary is written.
      if (stage === "summarize" && ++summaries === 1) {
        const low = r.findings.listByTask(taskId).find((f) => f.status === "open");
        h.engine.overrideFinding(taskId, low!.id, { status: "force-fix" });
      }
      return {};
    });
    const seeded = seedTask();
    taskId = seeded.id;
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(2);
    const [low] = r.findings.listByTask(seeded.id).filter((f) => f.title === lowFinding.title);
    expect(low!.status).toBe("fixed");
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "summarize")).toHaveLength(2);
  });

  it("refuses to finish with a force-fixed finding not yet fixed", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });

    // Bypasses the engine, so no fix round starts.
    const [low] = r.findings.listByTask(seeded.id);
    r.findings.setStatus(low!.id, "force-fix");
    await expect(
      h.engine.respond(seeded.id, { gate: "finish", decision: "approve" }),
    ).rejects.toThrow(/force-fixed finding is not fixed yet/);
  });

  it("keeps waiting at the finish gate when a finding is force-ignored", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);

    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-ignore" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("keeps waiting at a paused triage when a finding is force-fixed", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = await approved(h, { triageMode: "pause" });
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const [blocker] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, blocker!.id, { status: "force-fix" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(1);
  });

  it("queues one fix round when a finding is force-fixed twice at the finish gate", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [lowFinding] : [] } }
        : {},
    );
    const seeded = await approved(h);

    const [low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-fix" });
    await settle(h.engine);
    expect(h.calls.filter((c) => c.stage === "implement")).toHaveLength(2);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("rejects overrides on unknown or merged findings", () => {
    const seeded = seedTask();
    const [target, duplicate] = r.findings.createMany(
      [highFinding, highFinding].map((f) => ({ ...f, taskId: seeded.id })),
    );
    r.findings.update(duplicate!.id, { status: "merged", mergedIntoId: target!.id });
    const h = harness();
    expect(() => h.engine.overrideFinding(seeded.id, "nope", { status: "force-fix" })).toThrow(
      FindingNotFoundError,
    );
    expect(() =>
      h.engine.overrideFinding(seeded.id, duplicate!.id, { status: "force-ignore" }),
    ).toThrow(TaskStateError);
    expect(() =>
      h.engine.overrideFinding(seeded.id, target!.id, { status: "open" as never }),
    ).toThrow(InvalidGateResponseError);
  });

  it("reviews the whole branch first, then only each fix round's diff", async () => {
    const heads = ["h0", "h1"];
    const reviewGit = {
      mergeBase: vi.fn(async (_worktree: string, ref: string) => {
        if (ref !== "main") throw new Error("unknown ref");
        return "base";
      }),
      headSha: vi.fn(async () => heads.shift() ?? "h1"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") =>
        from === "base" ? `+round 0 ${to}` : `+round 1 ${to}`,
      ),
    };
    let reviews = 0;
    const h = harness(
      (stage) =>
        stage === "code-review"
          ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
          : {},
      { stages: createDefaultStages({ reviewGit }) },
    );
    const seeded = await approved(h);

    const prompts = h.calls.filter((c) => c.stage === "code-review").map((c) => c.options.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[0]).toContain("+round 0 h0");
    expect(prompts[0]).toContain("`git diff base h0`): everything this branch changes");
    expect(prompts[2]).toContain("+round 1 h1");
    expect(prompts[2]).toContain("`git diff h0 h1`): fix round 1");
    // One fork point lookup, trying main and origin/main.
    expect(reviewGit.mergeBase).toHaveBeenCalledTimes(2);
    // Each visit records its range on a harness step.
    const ranges = stepsOf(seeded.id)
      .filter((s) => s.stage === "code-review" && s.agentId === null)
      .map((s) => r.stepEvents.list(s.id).at(-1)!.payload);
    expect(ranges).toEqual([
      { from: "base", to: "h0" },
      { from: "h0", to: "h1" },
    ]);
  });

  it("reviews a stacked PR from its base branch, not from main", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async (_worktree: string, ref: string) =>
        ref === "origin/feature/a" ? "parent-tip" : "main-fork",
      ),
      headSha: vi.fn(async () => "h0"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") => `+${from} ${to}`),
    };
    const h = harness(() => ({}), { stages: createDefaultStages({ reviewGit }) });
    await approved(h, {
      origin: prOrigin(),
      mode: "work",
      branch: "feature/b",
      baseBranch: "feature/a",
    });

    const prompt = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(prompt).toContain("`git diff parent-tip h0`");
    expect(reviewGit.mergeBase).toHaveBeenCalledWith(
      expect.any(String),
      "origin/feature/a",
      "HEAD",
    );
  });

  it("gives the code reviewers the task's details", async () => {
    const h = harness((stage) => (stage === "code-review" ? { structured: { findings: [] } } : {}));
    await approved(h);
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).toContain("## Details\n\nLogin accepts empty passwords");
  });

  it("gives the code reviewers the other PRs of the stack as context", async () => {
    const stackContext = vi.fn(async () => "1. #6: Below\n2. #7: This ← this PR");
    const h = harness(() => ({}), { stages: createDefaultStages({ stackContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).toContain("## Other pull requests in the stack\n\n1. #6: Below");
    expect(stackContext).toHaveBeenCalledTimes(1);
  });

  it("still reviews when the stack's context fails", async () => {
    const stackContext = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("github.com: rate limited");
    });
    const h = harness(() => ({}), { stages: createDefaultStages({ stackContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).not.toContain("Other pull requests in the stack");
    expect(stackContext).toHaveBeenCalled();
  });

  it("gives the code reviewers the comments already on the pull request", async () => {
    const prCommentsContext = vi.fn(async () => "### Review comments\n\n**grace**: Off by one?");
    const h = harness(() => ({}), { stages: createDefaultStages({ prCommentsContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).toContain(
      "## Comments already on the pull request\n\n### Review comments\n\n**grace**: Off by one?",
    );
    expect(review).toContain(
      "Do not report what these comments already raise; mention one only if you add something new.",
    );
    expect(prCommentsContext).toHaveBeenCalledTimes(1);
  });

  it("still reviews when the pull request's comments fail to load", async () => {
    const prCommentsContext = vi.fn(async (): Promise<string | undefined> => {
      throw new Error("github.com: rate limited");
    });
    const h = harness(() => ({}), { stages: createDefaultStages({ prCommentsContext }) });
    await approved(h, { origin: prOrigin(), mode: "work" });
    const review = h.calls.find((c) => c.stage === "code-review")!.options.prompt;
    expect(review).not.toContain("Comments already on the pull request");
    expect(prCommentsContext).toHaveBeenCalled();
  });

  it("reviews a PR again at triage with the user's instruction", async () => {
    let reviews = 0;
    const h = harness((stage) => {
      if (stage !== "code-review") return {};
      reviews++;
      if (reviews === 1) return { structured: { findings: [highFinding] } };
      if (reviews === 2) return { structured: { findings: [lowFinding] } };
      // The re-review reports the first finding again.
      if (reviews === 3) return { structured: { findings: [highFinding] } };
      return { structured: { findings: [] } };
    });
    const seeded = seedTask({ mode: "review", origin: prOrigin(), freeText: "Focus on auth" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const first = h.calls.filter((c) => c.stage === "code-review");
    expect(first).toHaveLength(2);
    expect(first[0]!.options.prompt).toContain("Focus on auth");
    expect(first[0]!.options.prompt).not.toContain("Findings already reported");

    const [high, low] = r.findings.listByTask(seeded.id);
    h.engine.overrideFinding(seeded.id, low!.id, { status: "force-ignore" });
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "revise",
      message: "Check the SQL",
    });
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const again = h.calls.filter((c) => c.stage === "code-review").slice(2);
    expect(again).toHaveLength(2);
    const prompt = again[0]!.options.prompt;
    expect(prompt).toContain("Focus on auth");
    expect(prompt).toContain("## Instructions from the user\n\nCheck the SQL");
    expect(prompt).toContain("## Findings already reported");
    expect(prompt).toContain(highFinding.title);
    // The ignored finding is listed only as ignored.
    expect(prompt.split(lowFinding.title)).toHaveLength(2);
    expect(prompt.indexOf(lowFinding.title)).toBeGreaterThan(
      prompt.indexOf("Findings the user chose to ignore"),
    );
    // The re-report folds into the first finding; the user's pick stays.
    const findings = r.findings.listByTask(seeded.id);
    expect(findings).toHaveLength(3);
    expect(r.findings.get(high!.id)!.status).toBe("open");
    expect(r.findings.get(low!.id)!.status).toBe("force-ignore");
    expect(findings[2]).toMatchObject({ status: "merged", mergedIntoId: high!.id });

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    expect(h.delivered).toEqual([seeded.id]);
  });

  it("reviews the whole PR again on a review task's re-review", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async () => "base"),
      headSha: vi.fn(async () => "h0"),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") => `+${from}..${to}`),
    };
    const h = harness(
      (stage) => (stage === "code-review" ? { structured: { findings: [] } } : {}),
      { stages: createDefaultStages({ reviewGit }) },
    );
    const seeded = seedTask({ mode: "review", origin: prOrigin() });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "revise",
      message: "Look again",
    });
    await settle(h.engine);

    const prompts = h.calls.filter((c) => c.stage === "code-review").map((c) => c.options.prompt);
    expect(prompts).toHaveLength(4);
    expect(prompts[2]).toContain("+base..h0");
    expect(prompts[2]).toContain("`git diff base h0`): everything this branch changes");
    const ranges = stepsOf(seeded.id)
      .filter((s) => s.stage === "code-review" && s.agentId === null)
      .map((s) => r.stepEvents.list(s.id).at(-1)!.payload);
    expect(ranges).toEqual([
      { from: "base", to: "h0" },
      { from: "base", to: "h0" },
    ]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
  });

  it("skips the panel when the round changed nothing", async () => {
    const reviewGit = {
      mergeBase: vi.fn(async () => "base"),
      headSha: vi.fn(async () => "base"),
      diff: vi.fn(async () => ""),
    };
    const h = harness(() => ({}), { stages: createDefaultStages({ reviewGit }) });
    const seeded = await approved(h);
    expect(afterApproval(h)).toEqual(["implement", "summarize"]);
    expect(task(seeded.id)).toMatchObject({ gate: "finish" });
  });
});

describe("re-review a posted review", () => {
  const newFinding: ReviewFinding = {
    ...highFinding,
    severity: "low",
    file: "src/session.ts",
    title: "Session id logged",
    explanation: "The new commit logs the session id.",
  };

  /**
   * A Review PR task whose first review reported `highFinding` and was
   * posted; the PR's head on the remote is `remote.sha`, and moving the
   * worktree there moves the reviewed HEAD.
   */
  async function posted({
    ancestor = true,
    moves = true,
    findings = (reviews: number) => (reviews === 1 ? [highFinding] : []),
    archiveWorkspace,
  }: {
    ancestor?: boolean;
    moves?: boolean;
    findings?: (reviews: number) => ReviewFinding[];
    archiveWorkspace?: WorkspaceArchiver;
  } = {}) {
    let head = "h0";
    const remote = { sha: "h0" };
    const reviewGit = {
      mergeBase: vi.fn(async () => "base"),
      headSha: vi.fn(async () => head),
      diff: vi.fn(async (_worktree: string, from: string, to = "HEAD") => `+${from}..${to}`),
      isAncestor: vi.fn<ReviewGit["isAncestor"]>(async () => ancestor),
    };
    const prHead = {
      fetch: vi.fn<PrHeadSync["fetch"]>(async () => remote.sha),
      moveTo: vi.fn<PrHeadSync["moveTo"]>(async (_task, sha) => {
        if (moves) head = sha;
        return moves;
      }),
    };
    let reviews = 0;
    const h = harness(
      (stage) => {
        if (stage !== "code-review") return {};
        reviews++;
        return { structured: { findings: findings(reviews) } };
      },
      {
        stages: createDefaultStages({ reviewGit }),
        prHead,
        ...(archiveWorkspace ? { archiveWorkspace } : {}),
      },
    );
    const seeded = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/pr" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const ids = r.findings.listByTask(seeded.id).map((f) => f.id);
    await h.engine.respond(seeded.id, {
      gate: "triage",
      decision: "approve",
      delivery: { actions: ["pr-review"], findingIds: ids },
    });
    expect(task(seeded.id)).toMatchObject({ status: "done", deliveryTargets: ["pr-review"] });
    const prompts = () =>
      h.calls.filter((c) => c.stage === "code-review").map((c) => c.options.prompt);
    return { h, seeded, remote, prHead, reviewGit, prompts };
  }

  it("refreshes against the head the review covered", async () => {
    const { h, seeded, remote, prHead } = await posted();
    await expect(h.engine.refreshPullRequest(seeded.id)).resolves.toEqual({
      reviewedSha: "h0",
      headSha: "h0",
      changed: false,
    });
    remote.sha = "h1";
    await expect(h.engine.refreshPullRequest(seeded.id)).resolves.toEqual({
      reviewedSha: "h0",
      headSha: "h1",
      changed: true,
    });
    expect(prHead.moveTo).not.toHaveBeenCalled();
    expect(task(seeded.id).status).toBe("done");
  });

  it("refuses unless a done review task posted its review and a port can fetch", async () => {
    const { h, seeded } = await posted();
    const work = seedTask({ origin: prOrigin(), branch: "feature/w", worktreePath: dir });
    r.tasks.update(work.id, { status: "done", deliveryTargets: ["pr-review"] });
    const notDone = seedTask({ mode: "review", origin: prOrigin(), worktreePath: dir });
    r.tasks.update(notDone.id, { deliveryTargets: ["pr-review"] });
    const unposted = seedTask({ mode: "review", origin: prOrigin(), worktreePath: dir });
    r.tasks.update(unposted.id, { status: "done" });
    for (const t of [work, notDone, unposted]) {
      await expect(h.engine.refreshPullRequest(t.id)).rejects.toThrow(TaskStateError);
      await expect(h.engine.reReviewPullRequest(t.id)).rejects.toThrow(TaskStateError);
    }
    const noPort = harness();
    await expect(noPort.engine.refreshPullRequest(seeded.id)).rejects.toThrow(
      "Refreshing the pull request is not available",
    );
  });

  it("rebuilds a worktree archiving removed before moving it to the new head", async () => {
    const port = fakeArchiver();
    const { h, seeded, remote, prHead } = await posted({ archiveWorkspace: port });
    prHead.moveTo.mockImplementation(async () => {
      port.order.push("moveTo");
      return true;
    });
    h.engine.archive(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({
      worktreePath: null,
      worktreeRemovedAt: expect.any(Date),
    });
    remote.sha = "h1";

    await expect(h.engine.refreshPullRequest(seeded.id)).resolves.toMatchObject({ changed: true });
    await h.engine.reReviewPullRequest(seeded.id);
    expect(port.order).toEqual([`archive ${seeded.id}`, `restore ${seeded.id}`, "moveTo"]);
    expect(task(seeded.id)).toMatchObject({ worktreePath: dir, worktreeRemovedAt: null });
    await settle(h.engine);
  });

  it("reviews only the commits pushed since and stops at triage", async () => {
    const { h, seeded, remote, prHead, prompts } = await posted({
      findings: (reviews) => (reviews === 1 ? [highFinding] : reviews === 3 ? [newFinding] : []),
    });
    r.tasks.update(seeded.id, { archivedAt: new Date() });
    remote.sha = "h1";

    const queued = await h.engine.reReviewPullRequest(seeded.id);
    expect(queued).toMatchObject({ status: "queued", stage: "code-review", archivedAt: null });
    expect(prHead.moveTo).toHaveBeenCalledExactlyOnceWith(expect.anything(), "h1", "h0");
    expect(r.runs.listByTask(seeded.id)).toHaveLength(2);
    await settle(h.engine);

    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    const again = prompts().slice(2);
    expect(again).toHaveLength(2);
    expect(again[0]).toContain("+h0..h1");
    expect(again[0]).toContain(
      "`git diff h0 h1`): the commits pushed to the pull request since the last review.",
    );
    expect(again[0]).toContain("## Findings already posted on the pull request");
    expect(again[0]).toContain(highFinding.title);
    expect(again[0]).not.toContain("## Findings already reported");
    const run = r.runs.listByTask(seeded.id).at(-1)!;
    expect(
      r.findings
        .listByTask(seeded.id)
        .filter((f) => f.runId === run.id)
        .map((f) => f.title),
    ).toEqual([newFinding.title]);
  });

  it("lists each finding once on a Review again within a re-review", async () => {
    const { h, seeded, remote, prompts } = await posted({
      findings: (reviews) => (reviews === 1 ? [highFinding] : reviews === 3 ? [newFinding] : []),
    });
    remote.sha = "h1";
    await h.engine.reReviewPullRequest(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "triage", decision: "revise", message: "Again" });
    await settle(h.engine);

    const prompt = prompts()[4]!;
    expect(prompt).toContain("+h0..h1");
    const postedAt = prompt.indexOf("## Findings already posted on the pull request");
    const reportedAt = prompt.indexOf("## Findings already reported");
    expect(postedAt).toBeGreaterThan(-1);
    expect(reportedAt).toBeGreaterThan(postedAt);
    expect(prompt.split(highFinding.title)).toHaveLength(2);
    expect(prompt.indexOf(highFinding.title)).toBeGreaterThan(postedAt);
    expect(prompt.indexOf(highFinding.title)).toBeLessThan(reportedAt);
    expect(prompt.split(newFinding.title)).toHaveLength(2);
    expect(prompt.indexOf(newFinding.title)).toBeGreaterThan(reportedAt);
  });

  it("reviews the whole PR when a force-push orphaned the reviewed head", async () => {
    const { h, seeded, remote, reviewGit, prompts } = await posted({ ancestor: false });
    remote.sha = "h1";
    await h.engine.reReviewPullRequest(seeded.id);
    await settle(h.engine);
    expect(reviewGit.isAncestor).toHaveBeenCalledWith(expect.any(String), "h0", "h1");
    expect(prompts()[2]).toContain("`git diff base h1`): everything this branch changes");
  });

  it("refuses when nothing changed, the worktree moved, or a re-review runs", async () => {
    const unchanged = await posted();
    await expect(unchanged.h.engine.reReviewPullRequest(unchanged.seeded.id)).rejects.toThrow(
      "No new changes on the pull request since the review",
    );
    expect(unchanged.prHead.moveTo).not.toHaveBeenCalled();

    const dirty = await posted({ moves: false });
    dirty.remote.sha = "h1";
    await expect(dirty.h.engine.reReviewPullRequest(dirty.seeded.id)).rejects.toThrow(
      "The worktree of this review has local changes; clean it, then re-review",
    );
    expect(task(dirty.seeded.id).status).toBe("done");
    expect(r.runs.listByTask(dirty.seeded.id)).toHaveLength(1);

    const busy = await posted();
    let release: (sha: string) => void = () => undefined;
    busy.prHead.fetch.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const first = busy.h.engine.reReviewPullRequest(busy.seeded.id);
    await expect(busy.h.engine.reReviewPullRequest(busy.seeded.id)).rejects.toThrow(
      /already re-reviewing/,
    );
    release("h1");
    await expect(first).resolves.toMatchObject({ status: "queued" });
    await settle(busy.h.engine);
  });
});

describe("diff comments", () => {
  const comment = {
    file: "src/session.ts",
    lineStart: 12,
    lineEnd: 14,
    hunk: "@@ -10,3 +12,3 @@\n context\n-old\n+new",
    body: "Keep the old timeout\nIt is what the docs promise.",
  };

  async function atFinish(h: Harness) {
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    return seeded;
  }

  const implementCalls = (h: Harness) => h.calls.filter((c) => c.stage === "implement");

  it("turns comments at the finish gate into force-fixed findings and fixes them in a new round", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    const round = Math.max(...stepsOf(seeded.id).map((s) => s.round));

    const result = h.engine.commentOnDiff(seeded.id, {
      comments: [comment, { ...comment, file: "src/other.ts", body: "Rename this" }],
    });
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      status: "force-fix",
      severity: "high",
      file: "src/session.ts",
      lineStart: 12,
      lineEnd: 14,
      title: "Keep the old timeout",
      round,
    });
    expect(result.findings[0]!.explanation).toBe(
      `${comment.body}\n\n~~~~diff\n${comment.hunk}\n~~~~`,
    );
    for (const finding of result.findings) {
      expect(h.events).toContainEqual({ type: "finding.upserted", payload: { finding } });
    }
    // A free slot picks the queued task up at once.
    expect(result.task).toMatchObject({ status: "running", gate: null, stage: "implement" });

    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(2);
    expect(implementCalls(h)[1]!.options.prompt).toContain("Keep the old timeout");
    expect(implementCalls(h)[1]!.options.prompt).toContain("Rename this");
    expect(
      stepsOf(seeded.id)
        .filter((s) => s.stage === "implement")
        .at(-1)!.round,
    ).toBe(round + 1);
    expect(r.findings.listByTask(seeded.id).map((f) => f.status)).toEqual(["fixed", "fixed"]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("runs one more fix round from the escalation gate, past the round limit", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
    expect(implementCalls(h)).toHaveLength(MAX_FIX_ROUNDS + 1);

    const { findings, task: started } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(started).toMatchObject({ status: "running", gate: null, stage: "implement" });
    await settle(h.engine);

    expect(implementCalls(h)).toHaveLength(MAX_FIX_ROUNDS + 2);
    expect(implementCalls(h).at(-1)!.options.prompt).toContain("Keep the old timeout");
    expect(
      stepsOf(seeded.id)
        .filter((s) => s.stage === "implement")
        .at(-1)!.round,
    ).toBe(MAX_FIX_ROUNDS + 1);
    expect(r.findings.get(findings[0]!.id)!.status).toBe("fixed");
    // The reviewers still block, so the task escalates again.
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "escalation" });
  });

  it("keeps a paused triage waiting and fixes the comments once triage is approved", async () => {
    let reviews = 0;
    const h = harness((stage) =>
      stage === "code-review"
        ? { structured: { findings: reviews++ === 0 ? [highFinding] : [] } }
        : {},
    );
    const seeded = seedTask({ triageMode: "pause" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });

    const { findings, task: waiting } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(waiting).toMatchObject({ status: "needs-you", gate: "triage" });
    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(1);

    await h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await settle(h.engine);
    expect(implementCalls(h)).toHaveLength(2);
    expect(implementCalls(h)[1]!.options.prompt).toContain("Keep the old timeout");
    expect(r.findings.get(findings[0]!.id)!.status).toBe("fixed");
  });

  it("refuses comments outside the finish, triage and escalation gates, and outside review triage", async () => {
    const h = harness();
    const seeded = await atFinish(h);
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [] })).toThrow(
      InvalidGateResponseError,
    );
    expect(() =>
      h.engine.commentOnDiff(seeded.id, { comments: [{ ...comment, body: "  " }] }),
    ).toThrow(InvalidGateResponseError);

    r.tasks.update(seeded.id, { status: "running", gate: null });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(seeded.id, { status: "done", gate: null });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(seeded.id, { status: "needs-you", gate: "plan-approval" });
    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );

    const review = seedTask({ mode: "review", origin: prOrigin(), branch: "feature/x" });
    r.tasks.update(review.id, { status: "needs-you", gate: "finish" });
    expect(() => h.engine.commentOnDiff(review.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    r.tasks.update(review.id, { status: "needs-you", gate: "escalation" });
    expect(() => h.engine.commentOnDiff(review.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    expect(() => h.engine.commentOnDiff("nope", { comments: [comment] })).toThrow(
      TaskNotFoundError,
    );
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });

  it("refuses comments while the task delivers", async () => {
    let release = () => undefined as void;
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const seeded = await atFinish(h);
    const delivering = h.engine.respond(seeded.id, { gate: "finish", decision: "approve" });
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));

    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    release();
    await delivering;
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });

  async function atReviewTriage(h: Harness) {
    const seeded = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/x" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    return seeded;
  }

  it("adds a review task's comments at triage as open findings to post, queuing nothing", async () => {
    const h = harness((stage) =>
      stage === "code-review" ? { structured: { findings: [highFinding] } } : {},
    );
    const seeded = await atReviewTriage(h);
    const calls = h.calls.length;

    const { findings, task: waiting } = h.engine.commentOnDiff(seeded.id, { comments: [comment] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      stepId: null,
      reviewerAgentId: null,
      status: "open",
      severity: "high",
      title: "Keep the old timeout",
      explanation: comment.body,
    });
    expect(h.events).toContainEqual({
      type: "finding.upserted",
      payload: { finding: findings[0] },
    });
    expect(waiting).toMatchObject({ status: "needs-you", gate: "triage" });
    await settle(h.engine);
    expect(h.calls).toHaveLength(calls);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "triage" });
    expect(postableFindings(r.findings.listByTask(seeded.id)).map((f) => f.id)).toContain(
      findings[0]!.id,
    );
  });

  it("refuses a review task's comments while it delivers", async () => {
    let release = () => undefined as void;
    const h = harness(() => ({}), {
      deliver: () => new Promise<void>((resolve) => (release = resolve)),
    });
    const seeded = await atReviewTriage(h);
    const delivering = h.engine.respond(seeded.id, { gate: "triage", decision: "approve" });
    await vi.waitFor(() => expect(h.deliveries).toHaveLength(1));

    expect(() => h.engine.commentOnDiff(seeded.id, { comments: [comment] })).toThrow(
      TaskStateError,
    );
    release();
    await delivering;
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
  });
});

describe("deleting findings", () => {
  function reviewAtTriage() {
    const seeded = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/x" });
    r.tasks.update(seeded.id, { status: "needs-you", gate: "triage" });
    const [target, duplicate, other] = r.findings.createMany(
      [highFinding, highFinding, highFinding].map((f) => ({ ...f, taskId: seeded.id })),
    );
    r.findings.update(duplicate!.id, { status: "merged", mergedIntoId: target!.id });
    return { seeded, target: target!, duplicate: duplicate!, other: other! };
  }

  it("deletes a finding with the duplicates merged into it, so it is no longer posted", () => {
    const h = harness();
    const { seeded, target, duplicate, other } = reviewAtTriage();

    const { deletedIds } = h.engine.deleteFinding(seeded.id, target.id);
    expect(deletedIds).toEqual([duplicate.id, target.id]);
    expect(h.events).toContainEqual({
      type: "finding.deleted",
      payload: { taskId: seeded.id, findingIds: [duplicate.id, target.id] },
    });
    expect(r.findings.listByTask(seeded.id).map((f) => f.id)).toEqual([other.id]);
    expect(postableFindings(r.findings.listByTask(seeded.id)).map((f) => f.id)).toEqual([other.id]);
  });

  it("deletes ignored findings and the user's own comments too", () => {
    const h = harness();
    const { seeded, other } = reviewAtTriage();
    r.findings.setStatus(other.id, "force-ignore");
    expect(h.engine.deleteFinding(seeded.id, other.id).deletedIds).toEqual([other.id]);
    const [mine] = r.findings.createMany([
      { ...highFinding, taskId: seeded.id, stepId: null, reviewerAgentId: null },
    ]);
    expect(h.engine.deleteFinding(seeded.id, mine!.id).deletedIds).toEqual([mine!.id]);
  });

  it("refuses merged, fixed and unknown findings, work tasks and review tasks off triage", () => {
    const h = harness();
    const { seeded, target, duplicate, other } = reviewAtTriage();

    expect(() => h.engine.deleteFinding(seeded.id, duplicate.id)).toThrow(TaskStateError);
    r.findings.setStatus(other.id, "fixed");
    expect(() => h.engine.deleteFinding(seeded.id, other.id)).toThrow(TaskStateError);
    expect(() => h.engine.deleteFinding(seeded.id, "nope")).toThrow(FindingNotFoundError);

    const elsewhere = seedTask({ origin: prOrigin(), mode: "review", branch: "feature/y" });
    r.tasks.update(elsewhere.id, { status: "needs-you", gate: "triage" });
    expect(() => h.engine.deleteFinding(elsewhere.id, target.id)).toThrow(FindingNotFoundError);

    r.tasks.update(seeded.id, { status: "needs-you", gate: "finish" });
    expect(() => h.engine.deleteFinding(seeded.id, target.id)).toThrow(TaskStateError);

    const work = seedTask();
    r.tasks.update(work.id, { status: "needs-you", gate: "triage" });
    const [workFinding] = r.findings.createMany([{ ...highFinding, taskId: work.id }]);
    expect(() => h.engine.deleteFinding(work.id, workFinding!.id)).toThrow(TaskStateError);

    expect(r.findings.listByTask(seeded.id)).toHaveLength(3);
    expect(h.events.filter((e) => e.type === "finding.deleted")).toEqual([]);
  });
});
