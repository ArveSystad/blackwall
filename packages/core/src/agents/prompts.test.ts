import { describe, expect, it } from "vitest";
import { buildSystemPrompt, findingsContract, missingPlanSections } from "./prompts.js";

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
    expect(prompt).not.toContain("Plan output contract");
    expect(prompt).toContain("Do not commit, push");
  });

  it("injects the plan contract for the planner", () => {
    const prompt = buildSystemPrompt({
      agent: { prompt: "You are the planner." },
      stage: "inform",
      profile: "read-only",
      tags: [],
    });
    expect(prompt).toContain("## Plan output contract");
    expect(prompt).not.toContain("Questions output contract");
  });

  it("injects the plan and questions contracts for plan review", () => {
    const prompt = buildSystemPrompt({
      agent: { prompt: "You are the plan reviewer." },
      stage: "plan-review",
      profile: "read-only",
      tags: [],
    });
    expect(prompt).toContain("## Plan output contract");
    expect(prompt).toContain("## Questions output contract");
    expect(prompt).toContain('"needsHuman"');
    expect(prompt).not.toContain("Findings output contract");
  });

  it("says when no tags are defined", () => {
    expect(findingsContract([])).toContain("(none defined)");
  });
});

describe("missingPlanSections", () => {
  it("lists the contract headings a plan lacks", () => {
    const plan = "## Goal\n\nx\n\n## approach\n\ny\n\n## Changes ##\n\n- `a.ts`\n";
    expect(missingPlanSections(plan)).toEqual(["Risks", "Verification"]);
  });

  it("accepts a plan with every section", () => {
    const plan = ["Goal", "Approach", "Changes", "Risks", "Verification"]
      .map((s) => `## ${s}\n\ntext`)
      .join("\n\n");
    expect(missingPlanSections(plan)).toEqual([]);
  });
});
