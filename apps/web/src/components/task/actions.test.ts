import { describe, expect, it } from "vitest";
import { messageRoute } from "./actions";

describe("messageRoute", () => {
  it("sends a Review PR task's reviewers back over the PR at triage", () => {
    expect(messageRoute({ status: "needs-you", gate: "triage", mode: "review" })).toEqual({
      to: "reviewers",
      decision: "revise",
      send: "Review again",
      placeholder: "Ask the reviewers to look again, with this instruction…",
    });
  });

  it("has nowhere to send a Review PR task's message at any other gate or while it runs", () => {
    expect(messageRoute({ status: "needs-you", gate: "finish", mode: "review" })).toBe(null);
    expect(messageRoute({ status: "needs-you", gate: "escalation", mode: "review" })).toBe(null);
    expect(messageRoute({ status: "running", gate: null, mode: "review" })).toBe(null);
  });

  it("routes a work task's message as before", () => {
    expect(messageRoute({ status: "needs-you", gate: "triage", mode: "work" })).toMatchObject({
      to: "implementer",
      decision: "approve",
    });
    expect(messageRoute({ status: "needs-you", gate: "plan-approval", mode: null })).toMatchObject({
      to: "planner",
      decision: "revise",
    });
    expect(messageRoute({ status: "needs-you", gate: "finish", mode: null })).toMatchObject({
      to: "implementer",
      decision: "revise",
    });
  });
});
