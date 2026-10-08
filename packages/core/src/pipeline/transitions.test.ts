import { MAX_FIX_ROUNDS } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  InvalidGateResponseError,
  afterGate,
  afterStage,
  type PipelinePosition,
} from "./transitions.js";

const work: PipelinePosition = { kind: "work", triageMode: "intervene", round: 0 };
const review: PipelinePosition = { kind: "review", triageMode: "intervene", round: 0 };

describe("afterStage (work)", () => {
  it("walks the stages in order up to plan approval", () => {
    expect(afterStage("inform", undefined, work)).toEqual({
      kind: "stage",
      stage: "plan-review",
      round: 0,
    });
    expect(afterStage("plan-review", { openQuestions: 0, satisfied: true }, work)).toEqual({
      kind: "gate",
      gate: "plan-approval",
    });
    expect(afterStage("plan-review", { openQuestions: 2, satisfied: false }, work)).toEqual({
      kind: "gate",
      gate: "questions",
    });
    // Questions for the user come first, even in the last grill round.
    expect(afterStage("plan-review", { openQuestions: 1, satisfied: true }, work)).toEqual({
      kind: "gate",
      gate: "questions",
    });
  });

  it("grills the plan again until the reviewers are satisfied", () => {
    expect(afterStage("plan-review", { openQuestions: 0, satisfied: false }, work)).toEqual({
      kind: "stage",
      stage: "plan-review",
      round: 0,
    });
  });

  it("never reaches Implement from planning without the plan-approval gate", () => {
    const planning = [
      afterStage("inform", undefined, work),
      ...[0, 1].flatMap((openQuestions) =>
        [true, false].map((satisfied) =>
          afterStage("plan-review", { openQuestions, satisfied }, work),
        ),
      ),
      afterGate("questions", "approve", work),
      afterGate("plan-approval", "revise", work),
    ];
    for (const next of planning) {
      expect(next).not.toMatchObject({ kind: "stage", stage: "implement" });
      expect(next.kind).not.toBe("deliver");
    }
    expect(afterGate("plan-approval", "approve", work)).toMatchObject({ stage: "implement" });
  });

  it("retries the implementer on a failed check before review", () => {
    expect(afterStage("implement", undefined, work)).toMatchObject({ stage: "checks" });
    expect(afterStage("checks", { retryImplement: true }, work)).toEqual({
      kind: "stage",
      stage: "implement",
      round: 0,
    });
    expect(afterStage("checks", { retryImplement: false }, work)).toMatchObject({
      stage: "code-review",
    });
    expect(afterStage("code-review", undefined, work)).toMatchObject({ stage: "aggregate" });
  });

  it("loops on blocking findings and escalates after the round cap", () => {
    expect(afterStage("aggregate", { blocking: 0 }, work)).toMatchObject({ stage: "summarize" });
    expect(afterStage("aggregate", { blocking: 1 }, { ...work, round: 1 })).toEqual({
      kind: "stage",
      stage: "implement",
      round: 2,
    });
    expect(afterStage("aggregate", { blocking: 1 }, { ...work, round: MAX_FIX_ROUNDS })).toEqual({
      kind: "gate",
      gate: "escalation",
    });
    expect(afterStage("summarize", undefined, work)).toEqual({ kind: "gate", gate: "finish" });
  });

  it("pauses for triage before each fix round in pause mode", () => {
    const paused = { ...work, triageMode: "pause" as const };
    expect(afterStage("aggregate", { blocking: 2 }, paused)).toEqual({
      kind: "gate",
      gate: "triage",
    });
    expect(afterStage("aggregate", { blocking: 0 }, paused)).toMatchObject({ stage: "summarize" });
  });
});

describe("afterStage (review PR)", () => {
  it("skips planning and implementation and ends in triage", () => {
    expect(afterStage("inform", undefined, review)).toMatchObject({ stage: "code-review" });
    expect(afterStage("code-review", undefined, review)).toMatchObject({ stage: "aggregate" });
    expect(afterStage("aggregate", { blocking: 3 }, review)).toEqual({
      kind: "gate",
      gate: "triage",
    });
    expect(() => afterStage("implement", undefined, review)).toThrow(/no implement/);
  });
});

describe("afterGate", () => {
  it("approves or revises the plan", () => {
    expect(afterGate("plan-approval", "approve", work)).toEqual({
      kind: "stage",
      stage: "implement",
      round: 0,
    });
    expect(afterGate("plan-approval", "revise", work)).toMatchObject({ stage: "inform" });
    expect(afterGate("questions", "approve", work)).toMatchObject({ stage: "plan-review" });
    expect(() => afterGate("questions", "revise", work)).toThrow(InvalidGateResponseError);
  });

  it("accepts or extends the loop after an escalation", () => {
    const capped = { ...work, round: MAX_FIX_ROUNDS };
    expect(afterGate("escalation", "approve", capped)).toMatchObject({ stage: "summarize" });
    expect(afterGate("escalation", "revise", capped)).toEqual({
      kind: "stage",
      stage: "implement",
      round: MAX_FIX_ROUNDS + 1,
    });
  });

  it("delivers at finish, or sends the work back", () => {
    expect(afterGate("finish", "approve", work)).toEqual({ kind: "deliver" });
    expect(afterGate("finish", "revise", { ...work, round: 1 })).toEqual({
      kind: "stage",
      stage: "implement",
      round: 2,
    });
    expect(afterGate("triage", "approve", { ...work, round: 1 })).toMatchObject({ round: 2 });
    // Every blocker force-ignored at triage: nothing left to fix.
    expect(afterGate("triage", "approve", { ...work, round: 1, blocking: 0 })).toEqual({
      kind: "stage",
      stage: "summarize",
      round: 1,
    });
    expect(() => afterGate("triage", "revise", work)).toThrow(InvalidGateResponseError);
  });

  it("posts the review after triage in Review PR mode", () => {
    expect(afterGate("triage", "approve", review)).toEqual({ kind: "deliver" });
    expect(() => afterGate("plan-approval", "approve", review)).toThrow(InvalidGateResponseError);
  });
});
