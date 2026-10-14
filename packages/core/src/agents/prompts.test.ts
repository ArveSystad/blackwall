import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  CHAT_HISTORY_ENTRY_CHARS,
  chatStatePrompt,
  chatSystemPrompt,
  findingsContract,
  missingPlanSections,
} from "./prompts.js";

const agent = { prompt: "You are the security reviewer." };

describe("buildSystemPrompt", () => {
  it("injects the tag list and findings contract for code reviewers", () => {
    const prompt = buildSystemPrompt({
      agent,
      stage: "code-review",
      profile: "read-only",
      cli: "claude",
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
      cli: "claude",
      tags: ["security"],
    });
    expect(prompt).not.toContain("Findings output contract");
    expect(prompt).not.toContain("Plan output contract");
    expect(prompt).toContain("Do not commit, push");
    expect(prompt).toContain("`.blackwall/artifacts/`");
  });

  it("tells only implementers about screenshots", () => {
    const prompt = buildSystemPrompt({
      agent,
      stage: "code-review",
      profile: "read-only",
      cli: "claude",
      tags: [],
    });
    expect(prompt).not.toContain(".blackwall/artifacts/");
  });

  it("injects the plan contract for the planner", () => {
    const prompt = buildSystemPrompt({
      agent: { prompt: "You are the planner." },
      stage: "inform",
      profile: "read-only",
      cli: "claude",
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
      cli: "claude",
      tags: [],
    });
    expect(prompt).toContain("## Plan output contract");
    expect(prompt).toContain("## Questions output contract");
    expect(prompt).toContain('"needsHuman"');
    expect(prompt).not.toContain("Findings output contract");
  });

  it("guides only implementers on Claude Code, Copilot and OpenCode to the sub-agent", () => {
    const implementer = { agent, stage: "implement", profile: "implement", tags: [] } as const;
    const onClaude = buildSystemPrompt({ ...implementer, cli: "claude" });
    expect(onClaude).toContain("## Sub-agents");
    expect(onClaude).toContain("`blackwall-worker`");
    expect(onClaude).toContain("through the Agent tool");
    const onCopilot = buildSystemPrompt({ ...implementer, cli: "copilot" });
    expect(onCopilot).toContain("## Sub-agents");
    expect(onCopilot).toContain("`blackwall-worker`, is available through the task tool");
    expect(onCopilot).toContain("never in the background");
    const onOpencode = buildSystemPrompt({ ...implementer, cli: "opencode" });
    expect(onOpencode).toContain("## Sub-agents");
    expect(onOpencode).toContain("`blackwall-worker`, is available through the task tool");
    expect(
      buildSystemPrompt({
        agent,
        stage: "code-review",
        profile: "read-only",
        cli: "claude",
        tags: [],
      }),
    ).not.toContain("## Sub-agents");
    expect(
      buildSystemPrompt({
        agent,
        stage: "code-review",
        profile: "read-only",
        cli: "copilot",
        tags: [],
      }),
    ).not.toContain("## Sub-agents");
    expect(
      buildSystemPrompt({
        agent,
        stage: "code-review",
        profile: "read-only",
        cli: "opencode",
        tags: [],
      }),
    ).not.toContain("## Sub-agents");
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

describe("chat prompts", () => {
  it("gives the chat the read-only rules and every action kind", () => {
    const prompt = chatSystemPrompt();
    expect(prompt).toContain("You are read-only.");
    for (const kind of ["create-task", "message-task", "stop-task", "resume-task"]) {
      expect(prompt).toContain(`\`${kind}\``);
    }
  });

  it("lists the tasks and backlog before the user's text", () => {
    const prompt = chatStatePrompt({
      tasks: [
        {
          id: "t1",
          title: "Add dark mode",
          origin: { kind: "free-text" },
          mode: null,
          status: "needs-you",
          stage: "inform",
          gate: "plan-approval",
          shortSummary: null,
        },
      ],
      backlog: [],
      text: "What is waiting?",
    });
    expect(prompt).toContain(
      "- `t1` Add dark mode · origin free-text · status needs-you · stage inform · gate plan-approval",
    );
    expect(prompt).toContain("### Backlog\n\n(none)");
    expect(prompt.endsWith("What is waiting?")).toBe(true);
  });

  it("replays earlier messages before the user's text, truncating long ones", () => {
    const without = chatStatePrompt({ tasks: [], backlog: [], text: "Next?" });
    expect(chatStatePrompt({ tasks: [], backlog: [], text: "Next?", history: [] })).toBe(without);
    expect(without).not.toContain("## Earlier conversation");

    const prompt = chatStatePrompt({
      tasks: [],
      backlog: [],
      text: "Next?",
      history: [
        { role: "user", text: "What is waiting?" },
        { role: "assistant", text: "x".repeat(CHAT_HISTORY_ENTRY_CHARS + 50) },
      ],
    });
    const earlier = prompt.indexOf("## Earlier conversation");
    expect(earlier).toBeGreaterThan(prompt.indexOf("### Backlog"));
    expect(earlier).toBeLessThan(prompt.indexOf("## Message"));
    expect(prompt).toContain("**User:** What is waiting?\n\n**Assistant:** ");
    expect(prompt).toContain(`**Assistant:** ${"x".repeat(CHAT_HISTORY_ENTRY_CHARS - 1)}…\n`);
    expect(prompt).not.toContain("x".repeat(CHAT_HISTORY_ENTRY_CHARS));
    expect(prompt.endsWith("## Message\n\nNext?")).toBe(true);
  });
});
