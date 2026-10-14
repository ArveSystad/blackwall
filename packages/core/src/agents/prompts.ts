import {
  MAX_TITLE_CHARS,
  SEVERITIES,
  type Agent,
  type AgentCli,
  type BacklogItem,
  type PermissionProfile,
  type Stage,
  type Task,
} from "@blackwall/shared";
import { SUBAGENT_CLIS, SUBAGENT_NAME, subagentTool } from "./subagents.js";

const WORKSPACE_RULES: Record<PermissionProfile, string> = {
  "read-only": [
    "You work in a git worktree: the current directory. Stay inside it.",
    "You are read-only. Do not create, edit or delete files.",
    "You may read and search files and run `git diff`, `git log`, `git show` and `git status`.",
  ].join("\n"),
  implement: [
    "You work in a git worktree: the current directory. Stay inside it.",
    "You may edit files and run shell commands such as builds and tests.",
    "Do not commit, push, fetch or touch git remotes, and do not use `gh`: the harness commits and delivers your work.",
    "When the task changes something visual and you can render it with the repo's own tooling, you may save PNG, JPEG, GIF or WebP screenshots to `.blackwall/artifacts/`: they show in the task's Artifacts tab and are never committed.",
  ].join("\n"),
};

/** The workspace rules for a permission profile, one rule per line. */
export function workspaceRules(profile: PermissionProfile): string {
  return WORKSPACE_RULES[profile];
}

/** The sections every plan has, in order, as `## <section>` headings. */
export const PLAN_SECTIONS = ["Goal", "Approach", "Changes", "Risks", "Verification"] as const;

/**
 * The plan output contract, injected for the planner and plan reviewers: the
 * markdown shape every plan follows, so reviewers and the implementer can find
 * their way around it.
 */
export function planContract(): string {
  return [
    "## Plan output contract",
    "",
    "A plan is markdown with exactly these second-level headings, in this order:",
    "",
    "- `## Goal`: what the change achieves and for whom, in one or two sentences.",
    "- `## Approach`: the design, the decisions taken and why; name the existing code it builds on.",
    "- `## Changes`: one bullet per file to add, change or delete: `` `path/to/file` `` and what changes there.",
    "- `## Risks`: assumptions, edge cases and what could break; write `None known.` when there are none.",
    "- `## Verification`: the tests to add or update and the commands that prove the change works.",
    "",
    "Use repo-relative paths. Keep it concrete enough that another engineer could implement it without asking.",
    "When you write a plan, reply with the plan only: no preamble and no closing remarks.",
    "When a JSON reply carries a plan (a `plan` field), that field holds the full plan in this shape.",
  ].join("\n");
}

/** The plan sections a plan lacks, by {@link PLAN_SECTIONS} heading. Empty when it follows the contract. */
export function missingPlanSections(plan: string): string[] {
  const headings = new Set(
    [...plan.matchAll(/^##[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map(([, h = ""]) => h.toLowerCase()),
  );
  return PLAN_SECTIONS.filter((s) => !headings.has(s.toLowerCase()));
}

/**
 * The questions output contract, injected for plan review: how reviewers ask
 * grill questions (and route them to the user with `needsHuman`), and how the
 * planner answers them.
 */
export function questionsContract(): string {
  return [
    "## Questions output contract",
    "",
    "Plan review is a grill: reviewers ask questions, the planner answers them and revises the plan.",
    "",
    "Reviewers reply with one JSON object listing their questions:",
    "",
    "```json",
    '{ "questions": [{ "question": "<one specific question>", "needsHuman": false }] }',
    "```",
    "",
    "- One question per entry, answerable in a few sentences. Quote the part of the plan it is about.",
    "- Ask only what would change the plan. Never repeat a question already answered.",
    "- `needsHuman: true` only for decisions the repository cannot settle: product behaviour, scope, priorities, trade-offs the user owns.",
    "  Anything the code, tests or docs can answer is `needsHuman: false`; the planner answers it.",
    '- Reply `{ "questions": [] }` when the plan is ready to implement.',
    "",
    "The planner replies with one JSON object answering the numbered questions and carrying the revised plan:",
    "",
    "```json",
    '{ "answers": [{ "question": 1, "answer": "<answer, or null>" }], "plan": "<the full revised plan>" }',
    "```",
    "",
    "- Answer from the repository and cite the files you relied on.",
    "- Answer `null` when only the user can decide. Never guess a product or scope decision.",
  ].join("\n");
}

/**
 * The findings output contract, injected into every code reviewer's prompt
 * together with the current tag list.
 */
export function findingsContract(tags: readonly string[]): string {
  const tagList = tags.length > 0 ? tags.map((t) => `\`${t}\``).join(", ") : "(none defined)";
  return [
    "## Findings output contract",
    "",
    "Review only the changes in this round's diff. Report each problem as one finding.",
    "Your final answer is one JSON object of this shape:",
    "",
    "```json",
    "{",
    '  "findings": [',
    "    {",
    `      "severity": "${SEVERITIES.join('" | "')}",`,
    '      "tags": ["<one or more tags from the list below>"],',
    '      "file": "<repo-relative path, or null when not tied to a file>",',
    '      "lineStart": <first line, or null>,',
    '      "lineEnd": <last line, or null>,',
    '      "title": "<one-line summary>",',
    '      "explanation": "<what is wrong and why it matters>",',
    '      "suggestedFix": "<how to fix it, or null>"',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "Severity: `critical` and `high` block the change until fixed; use them only for real defects",
    "(broken behaviour, security holes, data loss). `medium` and `low` are reported in the summary.",
    "Line numbers refer to the file after the change.",
    'Return `{ "findings": [] }` when you find nothing worth reporting.',
    "",
    `Tags (use only these): ${tagList}`,
  ].join("\n");
}

export interface SystemPromptContext {
  agent: Pick<Agent, "prompt">;
  stage: Stage;
  profile: PermissionProfile;
  /** The CLI the agent runs on: only Claude and Copilot implementers get the sub-agent guide. */
  cli: AgentCli;
  /** Current finding tags, in display order. */
  tags: readonly string[];
}

/** The output contracts a stage's agents follow. */
function contractsFor(stage: Stage, tags: readonly string[]): string[] {
  switch (stage) {
    case "inform":
      return [planContract()];
    case "plan-review":
      return [planContract(), questionsContract()];
    case "code-review":
      return [findingsContract(tags)];
    default:
      return [];
  }
}

/**
 * How an implementer hands narrow jobs to the harness-defined sub-agent, and
 * how lean its briefs must be: the worker sees only the brief.
 */
export function subagentGuide(cli: AgentCli): string {
  return [
    "## Sub-agents",
    "",
    `A cheaper, faster sub-agent, \`${SUBAGENT_NAME}\`, is available through the ${subagentTool(cli)} tool. It follows the same workspace rules.`,
    "",
    "- Delegate mechanical, self-contained jobs to it: an edit across named files, a search, running a build or test and reporting the result.",
    "- Keep design decisions, tricky logic and the final check of the worker's changes for yourself.",
    "- Brief it with only the exact files, the change or command, and what to report back. Never paste the plan, the task context or the conversation: it sees only the brief.",
    "- Run independent jobs in parallel, never in the background. Skip delegation when doing the job yourself is quicker.",
  ].join("\n");
}

/**
 * The system prompt of the repo chat: the role, the read-only workspace rules
 * and the actions contract. The agent proposes actions; the user applies them.
 */
export function chatSystemPrompt(): string {
  return [
    "You are Blackwall's chat assistant for one repository. Answer questions about its code, its backlog and its tasks.",
    "Keep replies short and concrete; use markdown, and cite files as repo-relative paths.",
    "",
    "## Workspace rules",
    "",
    workspaceRules("read-only"),
    "",
    "## Actions contract",
    "",
    "Each message starts with a fresh `Blackwall state` block listing the repo's tasks and backlog items. It is the only source of task ids.",
    "Reply with one JSON object: `reply` is your markdown answer, `actions` lists actions you propose. Nothing happens until the user applies one.",
    "",
    `- \`create-task\` \`{ title, description }\`: add a task to the repo's backlog. A title of at most ${MAX_TITLE_CHARS} characters; a description an engineer could plan from.`,
    "- `message-task` `{ taskId, message }`: instructions for a task waiting at a gate (status `needs-you`). Running tasks only read messages at a gate, so never propose it for a task that is not at one.",
    "- `stop-task` `{ taskId }`: stop a `queued` or `running` task.",
    "- `resume-task` `{ taskId }`: resume an `interrupted` or `failed` task.",
    "",
    "Use only task ids from the state block and never invent tasks. Propose actions only when the user asks for them or they clearly help;",
    "otherwise reply with an empty `actions` list.",
  ].join("\n");
}

/** A task as the chat's state block lists it. */
export type ChatStateTask = Pick<
  Task,
  "id" | "title" | "origin" | "mode" | "status" | "stage" | "gate" | "shortSummary"
>;

/** A backlog item as the chat's state block lists it. */
export type ChatStateBacklogItem = Pick<
  BacklogItem,
  "id" | "title" | "status" | "priority" | "freeText"
>;

/** Longest backlog description excerpt in the chat's state block. */
const STATE_EXCERPT_CHARS = 200;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > STATE_EXCERPT_CHARS ? `${flat.slice(0, STATE_EXCERPT_CHARS - 1)}…` : flat;
}

/**
 * One chat message's prompt: a fresh `Blackwall state` block with the repo's
 * unarchived tasks and backlog items, then the user's text.
 */
export function chatStatePrompt({
  tasks,
  backlog,
  text,
}: {
  tasks: readonly ChatStateTask[];
  backlog: readonly ChatStateBacklogItem[];
  text: string;
}): string {
  const taskLines = tasks.map((t) =>
    [
      `- \`${t.id}\` ${t.title}`,
      `origin ${t.origin.kind}${t.mode ? ` (${t.mode})` : ""}`,
      `status ${t.status}`,
      `stage ${t.stage ?? "none"}`,
      `gate ${t.gate ?? "none"}`,
      ...(t.shortSummary ? [`summary: ${excerpt(t.shortSummary)}`] : []),
    ].join(" · "),
  );
  const backlogLines = backlog.map((i) =>
    [
      `- \`${i.id}\` ${i.title}`,
      `status ${i.status}`,
      `priority ${i.priority}`,
      ...(i.freeText.trim() ? [excerpt(i.freeText)] : []),
    ].join(" · "),
  );
  return [
    "## Blackwall state",
    "",
    "### Tasks",
    "",
    ...(taskLines.length > 0 ? taskLines : ["(none)"]),
    "",
    "### Backlog",
    "",
    ...(backlogLines.length > 0 ? backlogLines : ["(none)"]),
    "",
    "## Message",
    "",
    text,
  ].join("\n");
}

/**
 * The system prompt for one step: the agent's persona, the workspace rules for
 * its permission profile and the output contracts of the stage: the plan
 * contract for Inform, plan and questions for Plan review, and the tag list and
 * findings contract for Code review. Implementers on a CLI with the worker
 * ({@link SUBAGENT_CLIS}) also get the sub-agent guide.
 */
export function buildSystemPrompt({
  agent,
  stage,
  profile,
  cli,
  tags,
}: SystemPromptContext): string {
  const parts = [
    agent.prompt.trim(),
    `## Workspace rules\n\n${WORKSPACE_RULES[profile]}`,
    ...contractsFor(stage, tags),
    ...(profile === "implement" && SUBAGENT_CLIS.includes(cli) ? [subagentGuide(cli)] : []),
  ];
  return parts.filter((part) => part !== "").join("\n\n");
}
