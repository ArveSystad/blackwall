import type { Finding } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { blockingFindings, planMerges, sameIssue } from "./findings.js";

let next = 0;
const now = new Date();

function finding(patch: Partial<Finding> = {}): Finding {
  next++;
  return {
    id: `f${next}`,
    taskId: "t1",
    runId: "r1",
    stepId: `s${next}`,
    reviewerAgentId: null,
    severity: "high",
    tags: ["correctness"],
    file: "src/login.ts",
    lineStart: 10,
    lineEnd: 12,
    title: "Password compared with ==",
    explanation: "Coercion lets an empty password through.",
    suggestedFix: null,
    status: "open",
    mergedIntoId: null,
    round: 0,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe("blockingFindings", () => {
  it("gates on open Critical/High and any force-fixed finding, never on ignored ones", () => {
    const gating = [
      finding({ severity: "critical" }),
      finding({ severity: "high" }),
      finding({ severity: "low", status: "force-fix" }),
    ];
    const passing = [
      finding({ severity: "medium" }),
      finding({ severity: "critical", status: "force-ignore" }),
      finding({ severity: "high", status: "fixed" }),
      finding({ severity: "high", status: "merged" }),
    ];
    expect(blockingFindings([...gating, ...passing])).toEqual(gating);
  });
});

describe("sameIssue", () => {
  it("matches nearby lines in the same file with a similar title or a shared tag", () => {
    const a = finding();
    expect(sameIssue(a, finding({ lineStart: 13, lineEnd: 14, title: "Loose comparison" }))).toBe(
      true,
    );
    expect(sameIssue(a, finding({ title: "Something else entirely", tags: ["security"] }))).toBe(
      false,
    );
    expect(sameIssue(a, finding({ file: "./src\\login.ts" }))).toBe(true);
  });

  it("keeps apart different files, distant lines and one reviewer's separate findings", () => {
    const a = finding();
    expect(sameIssue(a, finding({ file: "src/other.ts" }))).toBe(false);
    expect(sameIssue(a, finding({ lineStart: 40, lineEnd: 41 }))).toBe(false);
    expect(sameIssue(a, finding({ stepId: a.stepId }))).toBe(false);
  });

  it("needs close titles when lines or the file are missing", () => {
    const general = finding({
      file: null,
      lineStart: null,
      lineEnd: null,
      title: "No tests added",
    });
    expect(sameIssue(general, finding({ ...general, id: "x", stepId: "sx" }))).toBe(true);
    expect(
      sameIssue(general, finding({ file: null, lineStart: null, lineEnd: null, title: "No docs" })),
    ).toBe(false);
    expect(sameIssue(finding(), finding({ lineStart: null, lineEnd: null }))).toBe(true);
  });
});

describe("planMerges", () => {
  it("folds a round's duplicates into the most severe report", () => {
    const high = finding();
    const critical = finding({
      severity: "critical",
      tags: ["security"],
      lineStart: 8,
      lineEnd: 11,
      suggestedFix: "Use ===",
    });
    const other = finding({ file: "src/other.ts" });
    const [merge, ...rest] = planMerges([], [high, critical, other]);
    expect(rest).toEqual([]);
    expect(merge).toMatchObject({
      targetId: critical.id,
      duplicateIds: [high.id],
      patch: { severity: "critical", tags: ["security", "correctness"], lineStart: 8, lineEnd: 12 },
    });
    expect(merge!.patch.explanation).toContain("Also reported:\n- Password compared with ==");
  });

  it("keeps the user's override when the overridden finding has a duplicate", () => {
    const ignored = finding({ severity: "medium", status: "force-ignore" });
    const critical = finding({ severity: "critical" });
    expect(planMerges([], [critical, ignored])[0]).toMatchObject({
      targetId: ignored.id,
      duplicateIds: [critical.id],
    });
  });

  it("folds re-reports into an earlier active finding, but not into a fixed one", () => {
    const earlierIgnored = finding({ status: "force-ignore", round: 0 });
    const reReported = finding({ round: 1 });
    const [merge] = planMerges([earlierIgnored], [reReported]);
    expect(merge).toMatchObject({ targetId: earlierIgnored.id, duplicateIds: [reReported.id] });
    // An earlier target keeps its explanation.
    expect(merge!.patch.explanation).toBeUndefined();

    const earlierFixed = finding({ status: "fixed", round: 0 });
    expect(planMerges([earlierFixed], [finding({ round: 1 })])).toEqual([]);
  });

  it("plans nothing when there are no duplicates", () => {
    expect(planMerges([], [finding(), finding({ file: "src/b.ts" })])).toEqual([]);
  });
});
