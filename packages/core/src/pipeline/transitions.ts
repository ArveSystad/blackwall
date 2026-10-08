import {
  MAX_FIX_ROUNDS,
  type Gate,
  type GateDecision,
  type PrMode,
  type Stage,
  type TriageMode,
} from "@blackwall/shared";

/** Which pipeline a task runs: the full one, or the Review PR one. */
export type PipelineKind = "work" | "review";

export function pipelineKind(mode: PrMode | null): PipelineKind {
  return mode === "review" ? "review" : "work";
}

/** What each stage reports back to the engine, which decides where to go next. */
export interface StageResults {
  inform: void;
  /**
   * `openQuestions`: grill questions still waiting on a human. `satisfied`: the
   * reviewers have no more questions (or the grill round cap is reached), so the
   * plan goes to the user for approval; otherwise another grill round runs.
   */
  "plan-review": { openQuestions: number; satisfied: boolean };
  implement: void;
  /** `retryImplement`: a check failed and the implementer gets another go before review. */
  checks: { retryImplement: boolean };
  "code-review": void;
  /** Findings that gate the loop: open Critical/High ones plus any force-fixed ones. */
  aggregate: { blocking: number };
  summarize: void;
}

export type StageResult = StageResults[Stage];

/** Where the task goes after a stage or gate. */
export type Transition =
  /** Run `stage` next, in fix round `round`. */
  | { kind: "stage"; stage: Stage; round: number }
  /** Wait for the user at `gate`; the task leaves its slot. */
  | { kind: "gate"; gate: Gate }
  /** Run the delivery actions, then the task is done. */
  | { kind: "deliver" };

/** Where the task is when a transition is computed. */
export interface PipelinePosition {
  kind: PipelineKind;
  triageMode: TriageMode;
  /** Current fix round: 0 for the first implementation, then 1, 2, … */
  round: number;
  /** Findings that gate the loop right now (see `blockingFindings`); read by the triage gate. */
  blocking?: number;
}

/** Thrown when a gate response does not fit the gate or pipeline. */
export class InvalidGateResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGateResponseError";
  }
}

/** The first stage of every pipeline. */
export const FIRST_STAGE: Stage = "inform";

/**
 * The hardcoded pipeline (grill-result.md §3). Work: Inform → Plan review
 * (grill rounds, pausing at [questions] for answers only a human can give) →
 * [plan approval] → Implement → Checks → Code review → Aggregate, looping back
 * to Implement while blocking findings remain (at most {@link MAX_FIX_ROUNDS}
 * fix rounds, then escalate) → Summarize → [finish]. Review PR: Inform → Code
 * review → Aggregate → [triage] → post.
 */
export function afterStage<S extends Stage>(
  stage: S,
  result: StageResults[S],
  { kind, triageMode, round }: PipelinePosition,
): Transition {
  const go = (next: Stage, nextRound = round): Transition => ({
    kind: "stage",
    stage: next,
    round: nextRound,
  });

  if (kind === "review") {
    switch (stage) {
      case "inform":
        return go("code-review");
      case "code-review":
        return go("aggregate");
      case "aggregate":
        return { kind: "gate", gate: "triage" };
      default:
        throw new Error(`Review PR tasks have no ${stage} stage`);
    }
  }

  switch (stage) {
    case "inform":
      return go("plan-review");
    case "plan-review": {
      const { openQuestions, satisfied } = result as StageResults["plan-review"];
      if (openQuestions > 0) return { kind: "gate", gate: "questions" };
      // Implement is reachable only through the user's plan approval.
      return satisfied ? { kind: "gate", gate: "plan-approval" } : go("plan-review");
    }
    case "implement":
      return go("checks");
    case "checks":
      return (result as StageResults["checks"]).retryImplement
        ? go("implement")
        : go("code-review");
    case "code-review":
      return go("aggregate");
    case "aggregate": {
      if ((result as StageResults["aggregate"]).blocking === 0) return go("summarize");
      if (round >= MAX_FIX_ROUNDS) return { kind: "gate", gate: "escalation" };
      if (triageMode === "pause") return { kind: "gate", gate: "triage" };
      return go("implement", round + 1);
    }
    case "summarize":
      return { kind: "gate", gate: "finish" };
  }
  throw new Error(`Unknown stage ${String(stage)}`);
}

/** Where the task goes once the user answers `gate`. */
export function afterGate(
  gate: Gate,
  decision: GateDecision,
  { kind, round, blocking }: PipelinePosition,
): Transition {
  const go = (next: Stage, nextRound = round): Transition => ({
    kind: "stage",
    stage: next,
    round: nextRound,
  });

  if (kind === "review") {
    if (gate !== "triage") throw new InvalidGateResponseError(`Review PR tasks have no ${gate}`);
    if (decision !== "approve") {
      throw new InvalidGateResponseError("Select the findings to post, then approve");
    }
    return { kind: "deliver" };
  }

  switch (gate) {
    case "questions":
      // The answers are in; Plan review folds them into the plan and grills it again.
      if (decision !== "approve") {
        throw new InvalidGateResponseError("Answer the questions, then continue");
      }
      return go("plan-review");
    case "plan-approval":
      return decision === "approve" ? go("implement", 0) : go("inform");
    case "triage":
      if (decision !== "approve") {
        throw new InvalidGateResponseError("Triage the findings, then approve the fix round");
      }
      // The user force-ignored every blocker: nothing is left to fix.
      return blocking === 0 ? go("summarize") : go("implement", round + 1);
    case "escalation":
      // Approve: accept the code as is. Revise: one more fix round.
      return decision === "approve" ? go("summarize") : go("implement", round + 1);
    case "finish":
      return decision === "approve" ? { kind: "deliver" } : go("implement", round + 1);
  }
}
