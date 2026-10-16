import {
  MAX_TITLE_CHARS,
  SEVERITIES,
  type Agent,
  type AgentCli,
  type BacklogItem,
  type GrillQuestion,
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

/** Another registered repo an agent may read: its name and the absolute path of its folder. */
export interface ReferenceRepoPrompt {
  name: string;
  path: string;
}

/**
 * Where the reference repos are and how to use them; empty without any. Only
 * read-only agents and the chat get them.
 */
export function referenceReposSection(referenceRepos: readonly ReferenceRepoPrompt[]): string {
  if (referenceRepos.length === 0) return "";
  return [
    "## Reference repos",
    "",
    ...referenceRepos.map(({ name, path }) => `- ${name}: ${path}`),
    "",
    "You may read and search these folders. They are read-only, and git commands do not work on them.",
    "Cite their files as `<name>/<path>`.",
  ].join("\n");
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
  /** Other repos the agent may read; used only for the read-only profile. */
  referenceRepos?: readonly ReferenceRepoPrompt[];
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
export function chatSystemPrompt(referenceRepos: readonly ReferenceRepoPrompt[] = []): string {
  const refs = referenceReposSection(referenceRepos);
  return [
    "You are Blackwall's chat assistant for one repository. Answer questions about its code, its backlog and its tasks.",
    "Keep replies short and concrete; use markdown, and cite files as repo-relative paths.",
    "",
    "## Workspace rules",
    "",
    workspaceRules("read-only"),
    ...(refs === "" ? [] : ["", refs]),
    "",
    "## Actions contract",
    "",
    "Each message starts with a fresh `Blackwall state` block listing the repo's tasks, their open questions and the backlog items. It is the only source of task and question ids.",
    "Reply with one JSON object: `reply` is your markdown answer, `actions` lists actions you propose. Nothing happens until the user applies one.",
    "",
    `- \`create-task\` \`{ title, description }\`: add a task to the repo's backlog. A title of at most ${MAX_TITLE_CHARS} characters; a description an engineer could plan from.`,
    "- `message-task` `{ taskId, message }`: instructions for a task waiting at a gate (status `needs-you`). Running tasks only read messages at a gate, so never propose it for a task that is not at one.",
    "- `answer-question` `{ taskId, questionId, answer }`: answer one open question of a task at the `questions` gate. Answering the last one continues the task.",
    "- `stop-task` `{ taskId }`: stop a `queued`, `running` or `needs-you` task.",
    "- `resume-task` `{ taskId, message? }`: resume an `interrupted` or `failed` task. `message` is guidance for the agent steps that failed or stopped. Leave it out for a task stopped at a gate (interrupted with a gate): resume puts it back at its gate, so message it there instead.",
    "",
    "Use only task and question ids from the state block and never invent tasks. Propose actions only when the user asks for them or they clearly help;",
    "otherwise reply with an empty `actions` list.",
    "",
    "## Focused task",
    "",
    'When the message comes with a `Focused task` section, the user is looking at that task: "this task" means it.',
    "When a task failed or was interrupted, explain its error first, then propose `resume-task` with guidance that addresses it, or `message-task` when it waits at a gate.",
    "When the focused task lists a worktree, the current directory is that worktree: read its files and use `git status`, `git diff <base>...HEAD` and `git log` there to diagnose failed checks, errors and conflicts.",
    "Otherwise the current directory is the repo's checkout.",
  ].join("\n");
}

/** A task as the chat's state block lists it. */
export type ChatStateTask = Pick<
  Task,
  "id" | "title" | "origin" | "mode" | "status" | "stage" | "gate" | "error" | "shortSummary"
>;

/** An open question waiting on the user, as the chat's prompt lists it. */
export type ChatStateQuestion = Pick<GrillQuestion, "id" | "question">;

/** The task the user is looking at, given in full in the chat's prompt. */
export interface ChatFocus {
  task: ChatStateTask & Pick<Task, "plan">;
  questions: readonly ChatStateQuestion[];
  /** The task's worktree, set when the chat turn runs in it. */
  worktree?: { path: string; branch: string | null; base: string };
}

/** A backlog item as the chat's state block lists it. */
export type ChatStateBacklogItem = Pick<BacklogItem, "id" | "title" | "status" | "freeText">;

/** Longest backlog description excerpt in the chat's state block. */
const STATE_EXCERPT_CHARS = 200;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > STATE_EXCERPT_CHARS ? `${flat.slice(0, STATE_EXCERPT_CHARS - 1)}…` : flat;
}

/** Longest error or plan the focused task section carries. */
export const CHAT_FOCUS_CHARS = 4000;

function capped(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > CHAT_FOCUS_CHARS ? `${trimmed.slice(0, CHAT_FOCUS_CHARS - 1)}…` : trimmed;
}

function focusSection({ task, questions, worktree }: ChatFocus): string[] {
  return [
    "## Focused task",
    "",
    'The user is looking at this task; "this task" means it.',
    "",
    `- id \`${task.id}\``,
    `- title ${task.title}`,
    `- status ${task.status} · stage ${task.stage ?? "none"} · gate ${task.gate ?? "none"}`,
    ...(worktree
      ? [
          `- worktree \`${worktree.path}\` (the current directory) · branch \`${worktree.branch ?? "none"}\` · forked from \`${worktree.base}\``,
        ]
      : []),
    "",
    ...(task.error ? ["### Error", "", capped(task.error), ""] : []),
    ...(task.plan ? ["### Plan", "", capped(task.plan), ""] : []),
    ...(questions.length > 0
      ? [
          "### Open questions for the user",
          "",
          ...questions.map((q) => `- \`${q.id}\` ${q.question.trim()}`),
          "",
        ]
      : []),
  ];
}

/** Longest earlier chat message carried into a fresh session's prompt. */
export const CHAT_HISTORY_ENTRY_CHARS = 2000;

/** An earlier chat message, replayed when the CLI session cannot be resumed. */
export interface ChatHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

function historyEntry({ role, text }: ChatHistoryEntry): string {
  const trimmed = text.trim();
  const short =
    trimmed.length > CHAT_HISTORY_ENTRY_CHARS
      ? `${trimmed.slice(0, CHAT_HISTORY_ENTRY_CHARS - 1)}…`
      : trimmed;
  return `**${role === "user" ? "User" : "Assistant"}:** ${short}`;
}

/**
 * One chat message's prompt: a fresh `Blackwall state` block with the repo's
 * unarchived tasks (with the error of failed and interrupted ones, and the
 * open questions per task in `questions`) and backlog items, then the user's
 * text. A `focus` task adds a `Focused task` section with its error, plan and
 * open questions in full. A turn that starts a new CLI session also gets the
 * earlier conversation, each message truncated to
 * {@link CHAT_HISTORY_ENTRY_CHARS}.
 */
export function chatStatePrompt({
  tasks,
  backlog,
  text,
  questions = {},
  focus,
  history = [],
}: {
  tasks: readonly ChatStateTask[];
  backlog: readonly ChatStateBacklogItem[];
  text: string;
  /** Open questions waiting on the user, by task id. */
  questions?: Readonly<Record<string, readonly ChatStateQuestion[]>>;
  focus?: ChatFocus;
  history?: readonly ChatHistoryEntry[];
}): string {
  const taskLines = tasks.flatMap((t) => [
    [
      `- \`${t.id}\` ${t.title}`,
      `origin ${t.origin.kind}${t.mode ? ` (${t.mode})` : ""}`,
      `status ${t.status}`,
      `stage ${t.stage ?? "none"}`,
      `gate ${t.gate ?? "none"}`,
      ...((t.status === "failed" || t.status === "interrupted") && t.error
        ? [`error: ${excerpt(t.error)}`]
        : []),
      ...(t.shortSummary ? [`summary: ${excerpt(t.shortSummary)}`] : []),
    ].join(" · "),
    ...(questions[t.id] ?? []).map((q) => `  - question \`${q.id}\`: ${excerpt(q.question)}`),
  ]);
  const backlogLines = backlog.map((i) =>
    [
      `- \`${i.id}\` ${i.title}`,
      `status ${i.status}`,
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
    ...(history.length > 0
      ? ["## Earlier conversation", "", ...history.flatMap((h) => [historyEntry(h), ""])]
      : []),
    ...(focus ? focusSection(focus) : []),
    "## Message",
    "",
    text,
  ].join("\n");
}

/**
 * The system prompt for one step: the agent's persona, the workspace rules for
 * its permission profile and the output contracts of the stage: the plan
 * contract for Inform, plan and questions for Plan review, and the tag list and
 * findings contract for Code review. Read-only agents also get their reference
 * repos ({@link referenceReposSection}). Implementers on a CLI with the worker
 * ({@link SUBAGENT_CLIS}) also get the sub-agent guide.
 */
export function buildSystemPrompt({
  agent,
  stage,
  profile,
  cli,
  tags,
  referenceRepos = [],
}: SystemPromptContext): string {
  const parts = [
    agent.prompt.trim(),
    `## Workspace rules\n\n${WORKSPACE_RULES[profile]}`,
    profile === "read-only" ? referenceReposSection(referenceRepos) : "",
    ...contractsFor(stage, tags),
    ...(profile === "implement" && SUBAGENT_CLIS.includes(cli) ? [subagentGuide(cli)] : []),
  ];
  return parts.filter((part) => part !== "").join("\n\n");
}
