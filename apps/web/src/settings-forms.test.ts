import type { Agent } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  addTag,
  agentDraft,
  agentsForRole,
  copyName,
  draftToInput,
  moveItem,
  parseLines,
  sameDraft,
} from "./settings-forms";

const agent: Agent = {
  id: "a1",
  name: "Security reviewer",
  cli: "copilot",
  model: null,
  prompt: "Look for injection.",
  eligibleStages: ["code-review", "plan-review"],
  permissionOverrides: { allow: ["shell(npm test)"] },
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("agent drafts", () => {
  it("round-trips an agent", () => {
    expect(draftToInput(agentDraft(agent))).toEqual({
      name: "Security reviewer",
      cli: "copilot",
      model: null,
      prompt: "Look for injection.",
      eligibleStages: ["plan-review", "code-review"],
      permissionOverrides: { allow: ["shell(npm test)"] },
    });
  });

  it("trims the name and model and drops blank rule lines", () => {
    const draft = {
      ...agentDraft(),
      name: "  Docs ",
      model: " opus ",
      deny: "\n  Bash(rm:*) \n\n",
    };
    expect(draftToInput(draft)).toMatchObject({
      name: "Docs",
      model: "opus",
      permissionOverrides: { deny: ["Bash(rm:*)"] },
    });
  });

  it("compares drafts by what they would save", () => {
    const draft = agentDraft(agent);
    expect(sameDraft(draft, { ...draft, allow: "shell(npm test)\n" })).toBe(true);
    expect(sameDraft(draft, { ...draft, cli: "claude" })).toBe(false);
  });
});

describe("helpers", () => {
  it("names copies", () => {
    expect(copyName("Planner", ["Planner"])).toBe("Planner (copy)");
    expect(copyName("Planner", ["Planner (copy)", "Planner (copy 2)"])).toBe("Planner (copy 3)");
  });

  it("parses lines", () => {
    expect(parseLines("pnpm test\r\n\n  pnpm lint  ")).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("filters agents by the role's stage", () => {
    const implementer = { ...agent, id: "a2", eligibleStages: ["implement" as const] };
    expect(agentsForRole([agent, implementer], "codeReviewers")).toEqual([agent]);
    expect(agentsForRole([agent, implementer], "implementer")).toEqual([implementer]);
  });
});

describe("tags", () => {
  it("normalises and appends a tag", () => {
    expect(addTag(["ux"], " Flaky Tests ")).toEqual({ ok: true, tags: ["ux", "flaky-tests"] });
  });

  it("rejects duplicates and bad names", () => {
    expect(addTag(["ux"], "UX")).toEqual({ ok: false, error: "ux is already listed" });
    expect(addTag([], "c++").ok).toBe(false);
    expect(addTag([], "   ").ok).toBe(false);
  });

  it("moves items within bounds", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 2, -2)).toEqual(["c", "a", "b"]);
  });
});
