import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  CHAT_FOCUS_CHARS,
  CHAT_HISTORY_ENTRY_CHARS,
  chatStatePrompt,
  chatSystemPrompt,
  findingsContract,
  MEMORIES_PROMPT_CHARS,
  memoriesPromptSection,
  missingPlanSections,
  PLAN_SECTIONS,
  voiceCommandPrompt,
  voiceSystemPrompt,
} from "./prompts.js";
import { VOICE_TOOL_NAMES } from "../voice/tools.js";

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

  it("tells only implementers about artifacts", () => {
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
    expect(prompt).toContain("## Summary");
    expect(prompt.indexOf("## Summary")).toBeLessThan(prompt.indexOf("## Goal"));
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

  it("guides implementers on Claude Code, Copilot and OpenCode to the sub-agent", () => {
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
    expect(onOpencode).toContain("an edit across named files");
    expect(onOpencode).not.toContain("Delegate fact-finding only");
  });

  it("guides read-only stages on Claude Code, Copilot and OpenCode to fact-finding only", () => {
    for (const [stage, cli, tool] of [
      ["inform", "claude", "Agent"],
      ["plan-review", "copilot", "task"],
      ["code-review", "opencode", "task"],
    ] as const) {
      const prompt = buildSystemPrompt({ agent, stage, profile: "read-only", cli, tags: [] });
      expect(prompt).toContain("## Sub-agents");
      expect(prompt).toContain(`\`blackwall-worker\`, is available through the ${tool} tool`);
      expect(prompt).toContain("Delegate fact-finding only");
      expect(prompt).toContain("send one worker per area, in parallel");
      expect(prompt).toContain("Keep every judgement for yourself");
      expect(prompt).toContain("absolute paths for reference repos");
      expect(prompt).not.toContain("an edit across named files");
    }
  });

  it("lists reference repos for read-only agents only", () => {
    const referenceRepos = [{ name: "lib", path: "/code/lib" }];
    const reviewer = buildSystemPrompt({
      agent,
      stage: "code-review",
      profile: "read-only",
      cli: "claude",
      tags: [],
      referenceRepos,
    });
    expect(reviewer).toContain("## Reference repos");
    expect(reviewer).toContain("- lib: /code/lib");
    expect(reviewer).toContain("git commands do not work on them");
    expect(reviewer).toContain("`<name>/<path>`");
    expect(
      buildSystemPrompt({
        agent,
        stage: "code-review",
        profile: "read-only",
        cli: "claude",
        tags: [],
      }),
    ).not.toContain("## Reference repos");
    expect(
      buildSystemPrompt({
        agent,
        stage: "implement",
        profile: "implement",
        cli: "claude",
        tags: [],
        referenceRepos,
      }),
    ).not.toContain("## Reference repos");
  });

  it("says when no tags are defined", () => {
    expect(findingsContract([])).toContain("(none defined)");
  });
});

describe("missingPlanSections", () => {
  it("lists the contract headings a plan lacks", () => {
    const plan = "## Goal\n\nx\n\n## approach\n\ny\n\n## Changes ##\n\n- `a.ts`\n";
    expect(missingPlanSections(plan)).toEqual(["Summary", "Risks", "Verification"]);
  });

  it("accepts a plan with every section", () => {
    const plan = PLAN_SECTIONS.map((s) => `## ${s}\n\ntext`).join("\n\n");
    expect(missingPlanSections(plan)).toEqual([]);
  });
});

describe("chat prompts", () => {
  it("gives the chat the read-only rules and every action kind", () => {
    const prompt = chatSystemPrompt();
    expect(prompt).toContain("You are read-only.");
    for (const kind of [
      "create-task",
      "message-task",
      "answer-question",
      "stop-task",
      "resume-task",
    ]) {
      expect(prompt).toContain(`\`${kind}\``);
    }
  });

  it("lists the chat's reference repos only when it has some", () => {
    expect(chatSystemPrompt()).not.toContain("## Reference repos");
    const prompt = chatSystemPrompt([
      { name: "lib", path: "/code/lib" },
      { name: "api", path: "/code/api" },
    ]);
    expect(prompt).toContain("## Reference repos");
    expect(prompt).toContain("- lib: /code/lib\n- api: /code/api");
    expect(prompt.indexOf("## Reference repos")).toBeLessThan(
      prompt.indexOf("## Actions contract"),
    );
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
          error: null,
          shortSummary: null,
        },
      ],
      backlog: [],
      text: "What is waiting?",
    });
    expect(prompt).not.toContain("## Focused task");
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

  const failedTask = {
    id: "t2",
    title: "Fix login",
    origin: { kind: "free-text" as const },
    mode: null,
    status: "failed" as const,
    stage: "implement" as const,
    gate: null,
    error: "pnpm install failed:\n  ENOTFOUND registry",
    shortSummary: null,
  };
  const grillTask = {
    ...failedTask,
    id: "t3",
    title: "Add export",
    status: "needs-you" as const,
    stage: "plan-review" as const,
    gate: "questions" as const,
    error: null,
  };

  it("lists the error of failed tasks and the open questions per task", () => {
    const prompt = chatStatePrompt({
      tasks: [failedTask, grillTask, { ...failedTask, id: "t4", status: "done" as const }],
      backlog: [],
      questions: { t3: [{ id: "q1", question: "Zip or tar?" }] },
      text: "Status?",
    });
    expect(prompt).toContain(
      "- `t2` Fix login · origin free-text · status failed · stage implement · gate none · error: pnpm install failed: ENOTFOUND registry",
    );
    expect(prompt).toContain("gate questions\n  - question `q1`: Zip or tar?");
    // Only failed and interrupted tasks show their error.
    expect(prompt.match(/error:/g)).toHaveLength(1);
    expect(prompt).not.toContain("## Focused task");
  });

  it("gives the focused task in full before the message, capping its plan", () => {
    const plan = "p".repeat(CHAT_FOCUS_CHARS + 10);
    const question = { id: "q1", question: "Zip or tar?" };
    const prompt = chatStatePrompt({
      tasks: [failedTask, grillTask],
      backlog: [],
      questions: { t3: [question] },
      focus: { task: { ...grillTask, plan }, questions: [question] },
      text: "Which should I pick?",
    });
    const focus = prompt.indexOf("## Focused task");
    expect(focus).toBeGreaterThan(prompt.indexOf("### Backlog"));
    expect(focus).toBeLessThan(prompt.indexOf("## Message"));
    const section = prompt.slice(focus);
    expect(section).toContain('This conversation is about this task; "this task" means it.');
    expect(section).toContain(
      "- id `t3`\n- title Add export\n- status needs-you · stage plan-review · gate questions",
    );
    expect(section).toContain(`### Plan\n\n${"p".repeat(CHAT_FOCUS_CHARS - 1)}…`);
    expect(section).not.toContain("p".repeat(CHAT_FOCUS_CHARS));
    expect(section).toContain("### Open questions for the user\n\n- `q1` Zip or tar?");
    expect(section).not.toContain("### Error");

    const failed = chatStatePrompt({
      tasks: [failedTask],
      backlog: [],
      focus: { task: { ...failedTask, plan: null }, questions: [] },
      text: "Why?",
    });
    expect(failed).toContain("### Error\n\npnpm install failed:\n  ENOTFOUND registry");
    expect(failed).not.toContain("### Plan");
    expect(failed).not.toContain("- worktree");
  });

  it("names the focused task's worktree, branch and fork point", () => {
    const prompt = chatStatePrompt({
      tasks: [failedTask],
      backlog: [],
      focus: {
        task: { ...failedTask, plan: null },
        questions: [],
        worktree: { path: "/wt/t2", branch: "agent/t2", base: "develop" },
      },
      text: "Why?",
    });
    expect(prompt).toContain(
      "- status failed · stage implement · gate none\n- worktree `/wt/t2` (the current directory) · branch `agent/t2` · forked from `develop`",
    );
    expect(chatSystemPrompt()).toContain(
      "When the focused task lists a worktree, the current directory is that worktree",
    );
  });
});

describe("memoriesPromptSection", () => {
  const memory = (text: string, extra: object = {}) => ({
    kind: "convention" as const,
    text,
    files: null,
    pinned: false,
    ...extra,
  });

  it("is empty without notes", () => {
    expect(memoriesPromptSection([])).toBe("");
  });

  it("shows the heading, the stale warning, kind, files and pinned", () => {
    const section = memoriesPromptSection([
      memory("Use pnpm", { pinned: true }),
      memory("Run codegen first", { kind: "pitfall", files: ["gen.ts", "schema.ts"] }),
    ]);
    expect(section).toContain("## What blackwall remembers about this repo");
    expect(section).toContain("when a note disagrees with the code, the code wins");
    expect(section).toContain("- [convention] Use pnpm (pinned)\n");
    expect(section).toContain("- [pitfall] Run codegen first (files: gen.ts, schema.ts)");
  });

  it("caps the section without cutting a note", () => {
    const notes = Array.from({ length: 20 }, (_, i) => memory(`${i} ${"x".repeat(400)}`));
    const section = memoriesPromptSection(notes);
    expect(section.length).toBeLessThanOrEqual(MEMORIES_PROMPT_CHARS);
    const bullets = section.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBeGreaterThan(5);
    expect(bullets.length).toBeLessThan(20);
    for (const b of bullets) expect(b).toMatch(/x{400}$/);
  });

  it("goes into the chat state only when there are notes", () => {
    const base = { tasks: [], backlog: [], text: "Next?" };
    const prompt = chatStatePrompt({ ...base, memories: [memory("Use pnpm")] });
    expect(prompt).toContain("## What blackwall remembers about this repo");
    expect(prompt.indexOf("### Backlog")).toBeLessThan(prompt.indexOf("Use pnpm"));
    expect(prompt.indexOf("Use pnpm")).toBeLessThan(prompt.indexOf("## Message"));
    expect(chatStatePrompt({ ...base, memories: [] })).toBe(chatStatePrompt(base));
    expect(chatStatePrompt(base)).not.toContain("What blackwall remembers");
  });
});

describe("voice prompts", () => {
  const noContext = { repos: [], selectedRepoId: "r1", focus: null, waiting: [] };

  it("names every blackwall tool and keeps the agent to them", () => {
    const prompt = voiceSystemPrompt();
    for (const name of VOICE_TOOL_NAMES) expect(prompt).toContain(`\`${name}\``);
    expect(prompt).toContain("Act only through the blackwall tools");
    expect(prompt).toContain("speech transcript");
    expect(prompt).toContain("call no tool and ask");
    expect(prompt).toContain("On a task page, chat always goes to the focused task's conversation");
    expect(prompt).toContain("use only ids from the `Voice state` block");
  });

  it("lists waiting items, the runner and the draft, then the transcript", () => {
    const prompt = voiceCommandPrompt({
      text: "start the dark mode task",
      backlog: [{ id: "b1", title: "Dark mode toggle" }],
      runner: { enabled: true, global: true },
      draft: null,
      ...noContext,
    });
    expect(prompt).toContain("- `b1` Dark mode toggle");
    expect(prompt).toContain("Backlog runner: on\n");
    expect(prompt).toContain("### Task draft\n\n(none)");
    expect(prompt.endsWith("## Transcript\n\nstart the dark mode task")).toBe(true);
  });

  it("puts the repo's notes before the transcript only when there are some", () => {
    const base = {
      text: "fix the login",
      backlog: [],
      runner: { enabled: true, global: true },
      draft: null,
      ...noContext,
    };
    const note = { kind: "convention" as const, text: "Use pnpm", files: null, pinned: false };
    const prompt = voiceCommandPrompt({ ...base, memories: [note] });
    expect(prompt).toContain("## What blackwall remembers about this repo");
    expect(prompt.indexOf("### Tasks waiting on you")).toBeLessThan(prompt.indexOf("Use pnpm"));
    expect(prompt.indexOf("Use pnpm")).toBeLessThan(prompt.indexOf("## Transcript"));
    expect(voiceCommandPrompt({ ...base, memories: [] })).toBe(voiceCommandPrompt(base));
    expect(voiceCommandPrompt(base)).not.toContain("What blackwall remembers");
  });

  it("says when Settings turned the runner off for every repo, and shows the draft", () => {
    const prompt = voiceCommandPrompt({
      text: "confirm",
      backlog: [],
      runner: { enabled: false, global: false },
      draft: { title: "Dark mode", description: "" },
      ...noContext,
    });
    expect(prompt).toContain("### Waiting backlog items\n\n(none)");
    expect(prompt).toContain("Backlog runner: off (off for every repo in Settings)");
    expect(prompt).toContain("- title: Dark mode\n- description: (empty)");
    expect(prompt).toContain("### Repositories\n\n(none)");
    expect(prompt).toContain("### Focused task\n\n(none)");
    expect(prompt).toContain("### Tasks waiting on you\n\n(none)");
  });

  it("lists the repos, the focused task with its open questions and the waiting tasks", () => {
    const prompt = voiceCommandPrompt({
      text: "answer question 3: yes",
      backlog: [],
      runner: { enabled: true, global: true },
      draft: null,
      repos: [
        { id: "r1", name: "app" },
        { id: "r2", name: "drops" },
      ],
      selectedRepoId: "r1",
      focus: {
        id: "t1",
        title: "Dark mode",
        repoName: "drops",
        status: "needs-you",
        gate: "questions",
        stage: "plan-review",
        // Q1 was answered: the open ones keep their numbers.
        questions: [
          { number: 2, question: "Which theme?" },
          { number: 3, question: "Keep the toggle?" },
        ],
      },
      waiting: [{ id: "t1", title: "Dark mode", repoName: "drops", gate: "questions" }],
    });
    expect(prompt).toContain("### Repositories\n\n- `r1` app (selected)\n- `r2` drops\n");
    expect(prompt).toContain(
      "- id: `t1`\n- title: Dark mode\n- repo: drops\n- status: needs-you\n- gate: questions\n- stage: plan-review",
    );
    expect(prompt).toContain(
      "Questions open for you:\n- Q2: Which theme?\n- Q3: Keep the toggle?\n",
    );
    expect(prompt).toContain("### Tasks waiting on you\n\n- `t1` Dark mode (drops, questions)\n");
    expect(prompt.indexOf("### Tasks waiting on you")).toBeLessThan(
      prompt.indexOf("## Transcript"),
    );
  });

  it("lists no questions away from the questions gate", () => {
    const prompt = voiceCommandPrompt({
      text: "approve the plan",
      backlog: [],
      runner: { enabled: true, global: true },
      draft: null,
      ...noContext,
      focus: {
        id: "t1",
        title: "Dark mode",
        repoName: "app",
        status: "needs-you",
        gate: "plan-approval",
        stage: "plan-review",
        questions: [],
      },
    });
    expect(prompt).toContain("- gate: plan-approval");
    expect(prompt).not.toContain("Questions open for you");
  });
});
