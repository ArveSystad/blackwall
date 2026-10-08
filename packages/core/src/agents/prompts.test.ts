import { describe, expect, it } from "vitest";
import { buildSystemPrompt, findingsContract } from "./prompts.js";

const agent = { prompt: "You are the security reviewer." };

describe("buildSystemPrompt", () => {
  it("injects the tag list and findings contract for code reviewers", () => {
    const prompt = buildSystemPrompt({
      agent,
      stage: "code-review",
      profile: "read-only",
      tags: ["security", "ux"],
    });
    expect(prompt.startsWith("You are the security reviewer.")).toBe(true);
    expect(prompt).toContain("## Findings output contract");
    expect(prompt).toContain("`security`, `ux`");
    expect(prompt).toContain('"severity": "critical" | "high" | "medium" | "low"');
    expect(prompt).toContain("You are read-only.");
  });

  it("leaves the contract out of other stages", () => {
    const prompt = buildSystemPrompt({
      agent: { prompt: "You are the implementer." },
      stage: "implement",
      profile: "implement",
      tags: ["security"],
    });
    expect(prompt).not.toContain("Findings output contract");
    expect(prompt).toContain("Do not commit, push");
  });

  it("says when no tags are defined", () => {
    expect(findingsContract([])).toContain("(none defined)");
  });
});
