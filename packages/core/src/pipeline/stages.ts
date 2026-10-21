import {
  MAX_CHECK_RETRIES,
  MAX_GRILL_ROUNDS,
  planAnswersOutputJsonSchema,
  planAnswersOutputSchema,
  planReviewOutputJsonSchema,
  planReviewOutputSchema,
  reviewOutputJsonSchema,
  reviewOutputSchema,
  originRef,
  parseFollowUps,
  shortSummarySchema,
  summaryCoreSchema,
  summaryOutputJsonSchema,
  SEVERITIES,
  type AgentRole,
  type DiffCommentInput,
  type Finding,
  type GrillQuestion,
  type Step,
  type Task,
} from "@blackwall/shared";
import type { AgentResult } from "../agents/adapters/types.js";
import type { NewFinding } from "../db/schema.js";
import { describeGitError, hookOutput } from "../git/errors.js";
import { isHookRejection, type GitService } from "../git/service.js";
import { defaultBranchOf } from "../repos/service.js";
import { ensureScratchDir } from "./artifacts.js";
import type { CiFailure } from "./ci.js";
import { runCheckCommand, type CheckOutcome, type CheckRunner } from "./checks.js";
import { blockingFindings, planMerges } from "./findings.js";
import { followUpsPromptSection } from "./follow-ups.js";
import { installSecurePlaybook } from "./playbook.js";
import type { RunAgentInput, StageContext, StageHandlers } from "./engine.js";
import type { PipelineKind, StageResults } from "./transitions.js";

/** A stage needs an agent for a role the task has none for. */
export class MissingAgentError extends Error {
  constructor(readonly role: AgentRole) {
    super(`The task has no ${role} agent`);
    this.name = "MissingAgentError";
  }
}

function single(task: Task, role: "planner" | "implementer" | "summarizer"): string {
  const id = task.agents[role];
  if (!id) throw new MissingAgentError(role);
  return id;
}

function panel(task: Task, role: "planReviewers" | "codeReviewers"): string[] {
  return task.agents[role] ?? [];
}

/**
 * Runs agents in parallel and waits for all of them, so a failing reviewer
 * never leaves its siblings running unobserved. Rethrows the first failure.
 */
export async function runPanel(
  ctx: StageContext,
  inputs: readonly RunAgentInput[],
): Promise<AgentResult[]> {
  const settled = await Promise.allSettled(inputs.map((input) => ctx.runAgent(input)));
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<AgentResult>).value);
}

function section(title: string, body: string | null | undefined): string {
  const text = body?.trim();
  return text ? `## ${title}\n\n${text}` : "";
}

function prompt(...parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

function describeOrigin(task: Task): string {
  const { origin } = task;
  switch (origin.kind) {
    case "jira-issue":
      return `Jira issue ${originRef(origin)}: ${task.title}`;
    case "github-pr":
      return `Pull request ${originRef(origin)}: ${task.title}`;
    case "github-issue":
      return `GitHub issue ${originRef(origin)}: ${task.title}`;
    case "free-text":
      return task.title;
  }
}

function describeFinding(f: Finding): string {
  const where = f.file ? ` (${f.file}${f.lineStart ? `:${f.lineStart}` : ""})` : "";
  const fix = f.suggestedFix ? `\n  Suggested fix: ${f.suggestedFix}` : "";
  return `- [${f.severity}] ${f.title}${where}\n  ${f.explanation}${fix}`;
}

/** Longest finding title a hunk comment gets; the whole comment is in the explanation. */
const MAX_COMMENT_TITLE_CHARS = 80;

/** A comment's first line as a finding title, cut to {@link MAX_COMMENT_TITLE_CHARS}. */
export function firstLineTitle(body: string): string {
  const firstLine = body.trim().split("\n", 1)[0]!.trim();
  return firstLine.length > MAX_COMMENT_TITLE_CHARS
    ? `${firstLine.slice(0, MAX_COMMENT_TITLE_CHARS - 1).trimEnd()}…`
    : firstLine;
}

/**
 * The finding for the user's comment on a hunk, titled with the comment's
 * first line. It has neither a step nor a reviewer (see `isUserComment`). In
 * a work task it is force-fixed and explained by the whole comment and the
 * hunk, so the implementer finds the code even when its lines move. In a
 * review task it is open, so it is offered for posting to the pull request,
 * and explained by the comment alone, as it is posted word for word.
 */
export function diffCommentFinding(
  task: Task,
  runId: string,
  round: number,
  comment: DiffCommentInput,
  pipeline: PipelineKind,
): NewFinding {
  const body = comment.body.trim();
  const title = firstLineTitle(body);
  return {
    taskId: task.id,
    runId,
    stepId: null,
    reviewerAgentId: null,
    severity: "high",
    tags: [],
    file: comment.file,
    lineStart: comment.lineStart,
    lineEnd: comment.lineEnd,
    title,
    explanation: pipeline === "review" ? body : `${body}\n\n${fence(comment.hunk, "diff")}`,
    suggestedFix: null,
    status: pipeline === "review" ? "open" : "force-fix",
    round,
  };
}

/**
 * The finding for a check that failed CI on the pushed commit, force-fixed
 * at Critical so a Fix CI round addresses it. Like a hunk comment it has
 * neither a step nor a reviewer; its explanation carries the conclusion, the
 * check's link and the end of its log, so it survives a restart.
 */
export function ciFailureFinding(
  task: Task,
  runId: string,
  round: number,
  { check, log }: CiFailure,
): NewFinding {
  const sha = task.ci?.sha.slice(0, 7);
  const lines = [
    `The \`${check.name}\` check ${check.conclusion ? `ended \`${check.conclusion}\`` : "failed"}${sha ? ` on the pushed commit ${sha}` : ""}. Make it pass.`,
    ...(check.url ? ["", `Details: ${check.url}`] : []),
    ...(log ? ["", "End of its log:", "", fence(log)] : ["", "Its log could not be fetched."]),
  ];
  return {
    taskId: task.id,
    runId,
    stepId: null,
    reviewerAgentId: null,
    severity: "critical",
    tags: [],
    file: null,
    lineStart: null,
    lineEnd: null,
    title: `CI failed: ${check.name}`,
    explanation: lines.join("\n"),
    suggestedFix: null,
    status: "force-fix",
    round,
  };
}

function describeQuestion(q: GrillQuestion): string {
  const answer = q.answer
    ? `\n  Answer (${q.answeredBy === "user" ? "user" : "planner"}): ${q.answer}`
    : "";
  return `- ${q.question}${answer}`;
}

/** The plan reviewers, minus the planner: it answers the questions rather than asking them. */
function planReviewers(task: Task): string[] {
  return panel(task, "planReviewers").filter((id) => id !== task.agents.planner);
}

/** Grill questions paired with the plan-review visit their reviewer step ran in. */
function questionsByVisit(
  questions: readonly GrillQuestion[],
  steps: readonly Step[],
): { question: GrillQuestion; visit: number }[] {
  const visits = new Map(
    steps.filter((s) => s.stage === "plan-review").map((s) => [s.id, s.visit]),
  );
  return questions.flatMap((question) => {
    const visit = question.stepId ? visits.get(question.stepId) : undefined;
    return visit === undefined ? [] : [{ question, visit }];
  });
}

/** The answer recorded for a question no one answered in autonomous mode. */
export const NO_HUMAN_ANSWER =
  "No human in the loop; the planner proceeds with the plan as written.";

const openHumanQuestions = (questions: readonly GrillQuestion[]) =>
  questions.filter((q) => q.needsHuman && q.answer === null).length;

/**
 * Plan review: the reviewer panel grills the plan in rounds, one stage visit
 * each. A grill round asks the reviewers for questions; the planner answers
 * those the repository can answer, hands the rest to the user (`needsHuman`)
 * and revises the plan. After the user answers at the questions gate, the next
 * visit folds those answers into the plan before grilling it again. The stage
 * is satisfied when the reviewers ask nothing new, or after
 * {@link MAX_GRILL_ROUNDS} rounds since Inform last wrote the plan; the plan
 * then waits for the user's approval.
 */
async function planReview(ctx: StageContext): Promise<StageResults["plan-review"]> {
  const { task, run, visit, repositories } = ctx;
  const planner = single(task, "planner");
  const reviewers = planReviewers(task);
  const steps = repositories.steps.listByRun(run.id);
  const questions = repositories.grillQuestions.listByTask(task.id);
  const earlier = questionsByVisit(questions, steps).filter((q) => q.visit < visit);
  const open = () => openHumanQuestions(repositories.grillQuestions.listByTask(task.id));

  // Earlier plan-review visits since Inform last wrote the plan; grill rounds are those the reviewers ran in.
  const sinceInform = steps
    .slice(steps.findLastIndex((s) => s.stage === "inform") + 1)
    .filter((s) => s.stage === "plan-review" && s.visit < visit);
  const rounds = new Set(
    sinceInform
      .filter((s) => s.agentId !== null && reviewers.includes(s.agentId))
      .map((s) => s.visit),
  ).size;
  const history = earlier.map((q) => q.question).filter((q) => q.answer !== null);

  // Right after the questions gate: the previous visit was a grill round the user answered.
  const previousVisit = Math.max(-1, ...sinceInform.map((s) => s.visit));
  const lastRound = earlier.filter((q) => q.visit === previousVisit).map((q) => q.question);
  if (lastRound.some((q) => q.answeredBy === "user")) {
    const result = await ctx.runAgent({
      agentId: planner,
      prompt: prompt(
        `# Task\n\n${describeOrigin(task)}`,
        section("Plan", task.plan),
        section("Questions and answers", lastRound.map(describeQuestion).join("\n")),
        "The user has answered the reviewers' open questions. Revise the plan so it follows every answer above, and reply with the full revised plan in markdown.",
      ),
    });
    ctx.updateTask({ plan: result.text });
    return { openQuestions: open(), satisfied: rounds >= MAX_GRILL_ROUNDS };
  }

  if (reviewers.length === 0 || rounds >= MAX_GRILL_ROUNDS) {
    return { openQuestions: open(), satisfied: true };
  }

  const results = await runPanel(
    ctx,
    reviewers.map((agentId) => ({
      agentId,
      prompt: prompt(
        `# Task\n\n${describeOrigin(task)}`,
        section("Details", task.freeText),
        section("Plan", task.plan),
        section("Already answered", history.map(describeQuestion).join("\n")),
        [
          "Grill this plan against the repository: gaps, ambiguities, risky assumptions and missing verification.",
          "Ask only questions whose answers would change the plan, and do not repeat questions already answered.",
          "Set `needsHuman` to true only for decisions the repository cannot settle (product behaviour, scope, priorities); the planner answers the rest from the code.",
          'Reply with a JSON object `{ "questions": [{ "question": "…", "needsHuman": false }] }`, or `{ "questions": [] }` when the plan is ready to implement.',
        ].join("\n"),
      ),
      jsonSchema: planReviewOutputJsonSchema(),
    })),
  );

  const visitSteps = repositories.steps
    .listByRun(run.id)
    .filter((s) => s.stage === "plan-review" && s.visit === visit);
  results.forEach((result, i) => {
    const askedByAgentId = reviewers[i]!;
    const parsed = planReviewOutputSchema.safeParse(result.structured);
    if (!parsed.success) throw new Error("A plan reviewer returned questions in the wrong shape");
    const stepId = visitSteps.filter((s) => s.agentId === askedByAgentId).at(-1)?.id ?? null;
    // A resumed visit reuses stored results; their questions are already saved.
    if (stepId === null || questions.some((q) => q.stepId === stepId)) return;
    for (const asked of parsed.data.questions) {
      const question = repositories.grillQuestions.create({
        taskId: task.id,
        runId: run.id,
        stepId,
        askedByAgentId,
        question: asked.question,
        needsHuman: asked.needsHuman,
      });
      ctx.publish({ type: "grill.upserted", payload: { question } });
    }
  });

  const stepIds = new Set(visitSteps.map((s) => s.id));
  const round = repositories.grillQuestions
    .listByTask(task.id)
    .filter((q) => q.stepId !== null && stepIds.has(q.stepId));
  if (round.length === 0) return { openQuestions: open(), satisfied: true };

  const numbered = round
    .map((q, i) => `${i + 1}. ${q.question}${q.needsHuman ? " (for the user)" : ""}`)
    .join("\n");
  const reply = await ctx.runAgent({
    agentId: planner,
    prompt: prompt(
      `# Task\n\n${describeOrigin(task)}`,
      section("Plan", task.plan),
      section("Already answered", history.map(describeQuestion).join("\n")),
      section("Reviewers' questions", numbered),
      [
        ...(ctx.autonomous
          ? [
              "No human is in the loop: answer every question by its number, including those marked (for the user), from the repository and your best judgement. Never answer null.",
            ]
          : [
              "Answer each question not marked (for the user) from the repository, by its number.",
              "Answer null when only the user can decide; do not guess product or scope decisions.",
            ]),
        "Then revise the plan with your answers.",
        'Reply with a JSON object `{ "answers": [{ "question": 1, "answer": "…" }], "plan": "<the full revised plan in markdown>" }`.',
      ].join("\n"),
    ),
    jsonSchema: planAnswersOutputJsonSchema(),
  });
  const parsed = planAnswersOutputSchema.safeParse(reply.structured);
  if (!parsed.success) throw new Error("The planner returned answers in the wrong shape");

  const answers = new Map(parsed.data.answers.map((a) => [a.question, a.answer]));
  round.forEach((q, i) => {
    // Questions flagged for a human are the user's to decide, never the planner's,
    // unless the repo is autonomous: then the planner decides everything.
    if (q.needsHuman && !ctx.autonomous) return;
    const answer = answers.get(i + 1) ?? null;
    const saved =
      answer !== null
        ? repositories.grillQuestions.answer(q.id, answer, "agent")
        : ctx.autonomous
          ? repositories.grillQuestions.answer(q.id, NO_HUMAN_ANSWER, "agent")
          : repositories.grillQuestions.markNeedsHuman(q.id);
    ctx.publish({ type: "grill.upserted", payload: { question: saved } });
  });
  ctx.updateTask({ plan: parsed.data.plan });
  return { openQuestions: open(), satisfied: false };
}

/** Step event a Checks (or setup) harness step logs when a check command starts. */
export const CHECK_STARTED_EVENT = "check.started";

/** Step event a Checks harness step logs when a check command finishes. */
export const CHECK_FINISHED_EVENT = "check.finished";

/** Step event a Checks harness step logs when it skips the check commands. */
export const CHECKS_SKIPPED_EVENT = "checks.skipped";

/** Payload of a {@link CHECKS_SKIPPED_EVENT} event; `files` is empty for `no-changes`. */
export interface ChecksSkipped {
  reason: "no-changes" | "docs-only";
  files: string[];
}

/** Payload of a {@link CHECK_FINISHED_EVENT} event. */
export interface CheckFinished extends CheckOutcome {
  command: string;
}

/** Diffs beyond this many characters are cut in the commit-message prompt. */
const MAX_COMMIT_DIFF_CHARS = 100_000;

const JIRA_KEY_AT_START = /^([A-Za-z][A-Za-z0-9_]*-\d+)(?![A-Za-z0-9])/;

/**
 * The Jira key commit messages start with: a Jira task's issue key, or for a
 * PR task a key opening one of its head branch's segments
 * (`feature/abc-123-login`). Free-text tasks have none.
 */
export function commitKey(task: Task): string | undefined {
  if (task.origin.kind === "jira-issue") return task.origin.key;
  if (task.origin.kind !== "github-pr" || !task.branch) return undefined;
  return task.branch
    .split("/")
    .map((part) => JIRA_KEY_AT_START.exec(part)?.[1])
    .find((key) => key !== undefined)
    ?.toUpperCase();
}

/** The Conventional Commits types a commit message may start with. */
const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "test",
  "docs",
  "build",
  "ci",
  "style",
  "chore",
  "revert",
];

/** A Conventional Commits summary line: type, optional scope, optional `!`, description. */
const CONVENTIONAL_HEADER = /^([a-z]+)(\([^)]*\))?(!)?: (.+)$/i;

/** Whether `text` starts with `key` as a whole word, ignoring case. */
function startsWithKey(text: string, key: string): boolean {
  return keyAtStart(key).test(text);
}

function keyAtStart(key: string): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?![A-Za-z0-9])`, "i");
}

/** The summary line split into a Conventional Commits prefix and description, or undefined. */
function conventionalHeader(line: string): { prefix: string; description: string } | undefined {
  const match = CONVENTIONAL_HEADER.exec(line);
  if (!match) return undefined;
  const [, type = "", scope = "", bang = "", description = ""] = match;
  if (!CONVENTIONAL_TYPES.includes(type.toLowerCase())) return undefined;
  return { prefix: `${type.toLowerCase()}${scope}${bang}: `, description };
}

/** The lower-cased Conventional Commits type of a message's summary line, or undefined. */
export function conventionalType(message: string): string | undefined {
  const type = CONVENTIONAL_HEADER.exec(message.trim().split("\n")[0] ?? "")?.[1]?.toLowerCase();
  return type && CONVENTIONAL_TYPES.includes(type) ? type : undefined;
}

/**
 * The summarizer's reply as a Conventional Commits message: unfenced and
 * trimmed, `chore: ` prefixed when the summary line has no valid type, and
 * `key` placed right after the type prefix (`feat(login): ABC-1 add login`).
 * Idempotent, so an already normalised message comes back unchanged.
 */
export function commitMessage(text: string, key: string | undefined): string {
  const message = text
    .trim()
    .replace(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/, "$1")
    .trim();
  const newline = message.indexOf("\n");
  let line = newline === -1 ? message : message.slice(0, newline);
  const body = newline === -1 ? "" : message.slice(newline);
  let header = conventionalHeader(line);
  if (!header && key && startsWithKey(line, key)) {
    line = line.replace(new RegExp(`${keyAtStart(key).source}\\s+`, "i"), "");
    header = conventionalHeader(line);
  }
  const { prefix, description } = header ?? { prefix: "chore: ", description: line };
  const keyed = key && !startsWithKey(description, key) ? `${key} ${description}` : description;
  return `${prefix}${keyed}${body}`;
}

/** Times the summarizer rewrites a commit message the repo's commit-msg hook rejected. */
export const MAX_COMMIT_MESSAGE_REWRITES = 3;

/**
 * Runs `commit(message)`; when the repo's commit-msg hook rejects it, has
 * `rewrite` write a new message from the rejected one and the hook's output,
 * and tries again, up to {@link MAX_COMMIT_MESSAGE_REWRITES} times. Any other
 * failure, or a rejection without `rewrite` or past the limit, is rethrown.
 * Returns the commit's result and the message it landed with.
 */
export async function commitWithRewrites<T>(
  commit: (message: string) => Promise<T>,
  message: string,
  rewrite: ((rejected: string, output: string) => Promise<string>) | undefined,
): Promise<{ result: T; message: string }> {
  let current = message;
  for (let rewrites = 0; ; rewrites++) {
    try {
      return { result: await commit(current), message: current };
    } catch (error) {
      if (!isHookRejection(error, "commit-msg") || !rewrite) throw error;
      if (rewrites >= MAX_COMMIT_MESSAGE_REWRITES) throw error;
      current = await rewrite(current, hookOutput(error));
    }
  }
}

/** The prompt that has the summarizer rewrite a commit message the commit-msg hook rejected. */
export function commitMessageRewritePrompt(task: Task, rejected: string, output: string): string {
  const key = commitKey(task);
  return prompt(
    `# Task\n\n${describeOrigin(task)}`,
    section("Rejected commit message", fence(rejected)),
    section("Hook output", fence(output)),
    [
      "The repo's commit-msg hook rejected this commit message. Write a corrected message that satisfies it.",
      "Keep the meaning.",
      "Reply with the commit message only.",
      key ? `Keep ${key} right after the type prefix (e.g. \`feat: ${key} …\`).` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** A fenced block that survives backtick fences inside `text`. */
export function fence(text: string, lang = ""): string {
  return `~~~~${lang}\n${text.trimEnd()}\n~~~~`;
}

function describeCheckFailure(check: CheckFinished): string {
  const how = check.timedOut ? "timed out" : `exited with code ${check.exitCode ?? "unknown"}`;
  return `\`${check.command}\` ${how}`;
}

/** The repo's check commands for the implementer, so it leaves the full suite to Checks. */
function describeCheckCommands(commands: readonly string[]): string {
  if (commands.length === 0) return "";
  return [
    ...commands.map((command) => `- \`${command}\``),
    "",
    "The harness runs these in the worktree after your round, in this order, and sends any failure back to you. Run only fast, targeted builds and tests for what you changed; do not run the whole suite or these commands in full.",
  ].join("\n");
}

/**
 * The harness commits the round's work: the summarizer writes the message from
 * the staged diff as a Conventional Commits message, with the Jira key after
 * the type prefix when there is one. A message the repo's commit-msg hook
 * rejects is rewritten by the summarizer in fresh steps (see
 * {@link commitWithRewrites}); the original summarizer step stays the visit's
 * first, so a resumed visit starts from its message again. Nothing happens
 * when the worktree has no changes (including a resumed visit that already
 * committed).
 */
async function commitRound(
  ctx: StageContext,
  git: Pick<GitService, "stagedDiff" | "commitAll">,
): Promise<void> {
  const { task, round } = ctx;
  const worktree = task.worktreePath;
  if (!worktree) throw new Error("The task has no worktree");
  // Rewritten every round, before staging, so artifacts are never committed.
  await ensureScratchDir(worktree);
  const diff = await git.stagedDiff(worktree);
  if (diff.trim() === "") return;

  const key = commitKey(task);
  let text =
    round === 0
      ? "chore: implement the approved plan"
      : `fix: address review findings (round ${round})`;
  const summarizer = task.agents.summarizer;
  if (summarizer) {
    const cut =
      diff.length > MAX_COMMIT_DIFF_CHARS
        ? `${diff.slice(0, MAX_COMMIT_DIFF_CHARS)}\n[… diff cut; run \`git diff --cached\` for the rest]`
        : diff;
    const result = await ctx.runAgent({
      agentId: summarizer,
      asStage: "summarize",
      prompt: prompt(
        `# Task\n\n${describeOrigin(task)}`,
        section("Plan", task.plan),
        section("Changes to commit", fence(cut)),
        [
          "Write the git commit message for the changes above in the Conventional Commits format, whatever style the repository's history uses: a summary line `<type>(<optional scope>): <description>` of at most 72 characters, type one of feat, fix, perf, refactor, test, docs, build, ci, style, chore, revert, description in the imperative mood; a blank line; then a short body on what changed and why.",
          "Reply with the commit message only, without code fences.",
          key ? `Do not mention ${key}; the harness adds it after the type prefix.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    });
    if (result.text.trim()) text = result.text;
  }
  const rewrite = summarizer
    ? async (rejected: string, output: string) => {
        const result = await ctx.runAgent({
          agentId: summarizer,
          asStage: "summarize",
          fresh: true,
          prompt: commitMessageRewritePrompt(task, rejected, output),
        });
        return commitMessage(result.text, key);
      }
    : undefined;
  await commitWithRewrites(
    (message) => git.commitAll(worktree, message),
    commitMessage(text, key),
    rewrite,
  );
}

/** The harness step of this stage visit, (re)started: one per visit, without an agent. */
export function startHarnessStep(ctx: StageContext): Step {
  const { run, stage, round, visit, repositories: r } = ctx;
  const earlier = r.steps
    .listByRun(run.id)
    .filter((s) => s.stage === stage && s.visit === visit && s.agentId === null)
    .at(-1);
  const started = { status: "running" as const, startedAt: new Date(), finishedAt: null };
  const step = earlier
    ? r.steps.update(earlier.id, { ...started, error: null })
    : r.steps.create({ runId: run.id, stage, agentId: null, round, visit, ...started });
  ctx.publish({ type: "step.upserted", payload: { step } });
  return step;
}

export function finishStep(
  ctx: StageContext,
  stepId: string,
  patch: Pick<Step, "status" | "error">,
): void {
  const step = ctx.repositories.steps.update(stepId, { ...patch, finishedAt: new Date() });
  ctx.publish({ type: "step.upserted", payload: { step } });
}

export function logEvent(ctx: StageContext, stepId: string, type: string, payload: unknown): void {
  const event = ctx.repositories.stepEvents.append(stepId, type, payload);
  ctx.publish({ type: "step.event", payload: { event } });
}

/** The failing check a failed Checks harness step logged last. */
function failedCheck(ctx: StageContext, step: Step): CheckFinished | undefined {
  if (step.status !== "failed") return undefined;
  const event = ctx.repositories.stepEvents.lastOfType(step.id, CHECK_FINISHED_EVENT);
  const check = event?.payload as CheckFinished | undefined;
  return check && check.exitCode !== 0 ? check : undefined;
}

/**
 * The check failure this Implement visit retries: the run's latest step
 * before it is a failed Checks harness step of the same fix round.
 */
function checkToFix(ctx: StageContext): CheckFinished | undefined {
  const { run, round, visit, repositories: r } = ctx;
  const previous = r.steps
    .listByRun(run.id)
    .filter((s) => !(s.stage === "implement" && s.visit === visit))
    .at(-1);
  if (previous?.stage !== "checks" || previous.agentId !== null || previous.round !== round) {
    return undefined;
  }
  return failedCheck(ctx, previous);
}

/** Failed Checks harness steps of earlier visits in this fix round: the implementer retries so far. */
function checkRetries(ctx: StageContext): number {
  const { run, round, visit, repositories: r } = ctx;
  return r.steps
    .listByRun(run.id)
    .filter(
      (s) =>
        s.stage === "checks" &&
        s.agentId === null &&
        s.round === round &&
        s.visit < visit &&
        s.status === "failed",
    ).length;
}

/**
 * Checks: the harness commits the round's work, then runs the repo's check
 * commands in order as one harness step, stopping at the first failure. A
 * failure goes back to the implementer (up to {@link MAX_CHECK_RETRIES} times
 * per fix round); one that persists becomes a Critical `correctness` finding,
 * which gates the code review loop like any reviewer's. A commit the repo's
 * pre-commit hook rejects is a failed check too, and the check commands are
 * skipped; one that persists past the retries fails the task with the hook's
 * output, as nothing could be committed to review. A commit-msg rejection the
 * summarizer's rewrites could not fix fails the task too, with the visit left
 * failed so a resume continues it.
 *
 * With `checksGit`, the check commands are skipped when the branch, after the
 * round's commit, changes no files since its fork point, or only Markdown and
 * `docs/` files; the step logs a {@link CHECKS_SKIPPED_EVENT} with the reason.
 */
async function runChecks(
  ctx: StageContext,
  git: Pick<GitService, "stagedDiff" | "commitAll"> | undefined,
  runCheck: CheckRunner,
  checksGit?: ChecksGit,
): Promise<StageResults["checks"]> {
  if (git) {
    try {
      await commitRound(ctx, git);
    } catch (error) {
      if (isHookRejection(error, "commit-msg")) {
        // Leaves the visit unfinished, so a resume continues it from the original summarizer step.
        const step = startHarnessStep(ctx);
        finishStep(ctx, step.id, { status: "failed", error: describeGitError(error) });
        throw error;
      }
      if (!isHookRejection(error, "pre-commit")) throw error;
      const step = startHarnessStep(ctx);
      const finished: CheckFinished = {
        command: "git commit (pre-commit hook)",
        exitCode: error.exitCode,
        output: hookOutput(error),
        timedOut: false,
      };
      logEvent(ctx, step.id, CHECK_FINISHED_EVENT, finished);
      finishStep(ctx, step.id, { status: "failed", error: describeGitError(error) });
      if (checkRetries(ctx) < MAX_CHECK_RETRIES) return { retryImplement: true };
      throw error;
    }
  }

  const { task, run, round, signal, repositories: r } = ctx;
  const commands = r.repos.get(task.repoId)?.checkCommands ?? [];
  if (commands.length === 0) return { retryImplement: false };
  const worktree = task.worktreePath;
  if (!worktree) throw new Error("The task has no worktree");

  const skipped = checksGit && (await checksSkipReason(ctx, checksGit, worktree));
  if (skipped) {
    const step = startHarnessStep(ctx);
    logEvent(ctx, step.id, CHECKS_SKIPPED_EVENT, skipped);
    finishStep(ctx, step.id, { status: "succeeded", error: null });
    return { retryImplement: false };
  }

  const step = startHarnessStep(ctx);
  let failure: CheckFinished | undefined;
  try {
    for (const command of commands) {
      logEvent(ctx, step.id, CHECK_STARTED_EVENT, { command });
      const outcome = await runCheck(command, { cwd: worktree, signal });
      if (signal.aborted) throw new Error("Interrupted");
      const finished: CheckFinished = { command, ...outcome };
      logEvent(ctx, step.id, CHECK_FINISHED_EVENT, finished);
      if (outcome.exitCode !== 0) {
        failure = finished;
        break;
      }
    }
  } catch (error) {
    finishStep(ctx, step.id, {
      status: signal.aborted ? "interrupted" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!failure) {
    finishStep(ctx, step.id, { status: "succeeded", error: null });
    return { retryImplement: false };
  }
  finishStep(ctx, step.id, { status: "failed", error: describeCheckFailure(failure) });

  const retries = checkRetries(ctx);
  if (retries < MAX_CHECK_RETRIES) return { retryImplement: true };

  // The implementer could not fix it: the review panel and the fix loop take over.
  if (!r.findings.listByTask(task.id).some((f) => f.stepId === step.id)) {
    const [finding] = r.findings.createMany([
      {
        taskId: task.id,
        runId: run.id,
        stepId: step.id,
        reviewerAgentId: null,
        severity: "critical",
        tags: ["correctness"],
        file: null,
        lineStart: null,
        lineEnd: null,
        title: `Check failed: ${failure.command}`,
        explanation: `${describeCheckFailure(failure)}, still after ${retries} implementer ${retries === 1 ? "retry" : "retries"}.\n\n${fence(failure.output)}`,
        suggestedFix: null,
        round,
      },
    ]);
    if (finding) ctx.publish({ type: "finding.upserted", payload: { finding } });
  }
  return { retryImplement: false };
}

/** Step event the Code review harness step logs with the range of the round's diff. */
export const REVIEW_DIFF_EVENT = "review.diff";

/** Payload of a {@link REVIEW_DIFF_EVENT} event: the round's diff is `git diff from to`. */
export interface ReviewDiffRange {
  from: string;
  to: string;
}

/** What Code review needs from git to find the round's diff. */
export type ReviewGit = Pick<GitService, "headSha" | "mergeBase" | "diff" | "commitsSince">;

/** What Checks needs from git to see what the branch changes. */
export type ChecksGit = Pick<GitService, "mergeBase" | "commitsSince" | "changedFiles">;

/** Whether a changed path is documentation: a Markdown file, or anything under the root `docs/`. */
export function isDocsPath(path: string): boolean {
  return /\.md$/i.test(path) || path.startsWith("docs/");
}

/**
 * Why Checks can skip the check commands: the branch changes no files since
 * its fork point, or only docs paths. Undefined when the checks should run,
 * including when the fork point or the changed files cannot be found.
 */
async function checksSkipReason(
  ctx: StageContext,
  git: ChecksGit,
  worktree: string,
): Promise<ChecksSkipped | undefined> {
  const { task, repositories: r } = ctx;
  try {
    const from = await forkPoint(task, git, worktree, defaultBranchOf(r.repos, task.repoId));
    if (from === undefined) return undefined;
    const files = await git.changedFiles(worktree, from);
    if (files.length === 0) return { reason: "no-changes", files: [] };
    if (files.every(isDocsPath)) return { reason: "docs-only", files };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Diffs beyond this many characters are cut in the reviewer prompt. */
const MAX_REVIEW_DIFF_CHARS = 150_000;

function storedRange(ctx: StageContext, step: Step): ReviewDiffRange | undefined {
  const event = ctx.repositories.stepEvents.lastOfType(step.id, REVIEW_DIFF_EVENT);
  return event?.payload as ReviewDiffRange | undefined;
}

/**
 * Where the task branch forked from the repo's default branch `mainBranch`:
 * the nearer of the local and remote default branch for branches the harness
 * created (one fast-forwarded to `origin/<mainBranch>` sits ahead of the local
 * one), the remote one first for PR branches. PR branches fork from their PR's
 * base branch first, which in a stack is the PR below, falling back to the
 * default branch.
 */
export async function forkPoint(
  task: Task,
  git: Pick<GitService, "mergeBase" | "commitsSince">,
  worktree: string,
  mainBranch: string,
): Promise<string | undefined> {
  const remote = `origin/${mainBranch}`;
  if (task.origin.kind !== "github-pr") {
    const bases: string[] = [];
    for (const ref of [mainBranch, remote]) {
      try {
        bases.push(await git.mergeBase(worktree, ref));
      } catch {
        // Skip a ref that does not resolve.
      }
    }
    const [local, other] = bases;
    if (local === undefined || other === undefined || local === other) return local;
    const [localCount, otherCount] = [
      await git.commitsSince(worktree, local),
      await git.commitsSince(worktree, other),
    ];
    return otherCount < localCount ? other : local;
  }
  const refs = [...(task.baseBranch ? [`origin/${task.baseBranch}`] : []), remote, mainBranch];
  for (const ref of refs) {
    try {
      return await git.mergeBase(worktree, ref);
    } catch {
      // Try the next ref.
    }
  }
  return undefined;
}

/**
 * The commit range this Code review visit reviews, recorded on the visit's
 * harness step so a resumed visit reviews the same diff: the whole branch in
 * the first round, then what changed since the previous review. A Review PR
 * task's re-reviews cover the whole branch again, as its HEAD never moves.
 * Undefined when the fork point cannot be found.
 */
async function reviewRange(
  ctx: StageContext,
  git: ReviewGit,
  worktree: string,
): Promise<ReviewDiffRange | undefined> {
  const { task, run, visit, repositories: r } = ctx;
  const harness = r.steps
    .listByRun(run.id)
    .filter((s) => s.stage === "code-review" && s.agentId === null);
  const current = harness.filter((s) => s.visit === visit).at(-1);
  const resumed = current && storedRange(ctx, current);
  if (resumed) return resumed;

  const previous =
    ctx.pipeline === "review"
      ? undefined
      : harness
          .filter((s) => s.visit < visit)
          .map((s) => storedRange(ctx, s))
          .filter((range) => range !== undefined)
          .at(-1);
  const from =
    previous?.to ?? (await forkPoint(task, git, worktree, defaultBranchOf(r.repos, task.repoId)));
  if (!from) return undefined;
  const range = { from, to: await git.headSha(worktree) };
  const step = startHarnessStep(ctx);
  logEvent(ctx, step.id, REVIEW_DIFF_EVENT, range);
  finishStep(ctx, step.id, { status: "succeeded", error: null });
  return range;
}

/**
 * Code review: the selected reviewers run in parallel, read-only, over the
 * round's diff (the whole branch in round 0, the fix since the last review
 * after that) and report findings in the findings output contract. Without
 * git (tests) they review the branch as it stands. A round with an empty diff
 * has nothing to review. The prompt carries the task's details and the user's
 * instructions, and for a stacked PR the other PRs' changes as context only
 * (from `stackContext`, whose failures never fail the review); a Review PR
 * re-review reviews the whole PR again and lists the findings already reported.
 * A PR task's existing comments (from `prCommentsContext`, a snapshot taken
 * once per visit whose failures are ignored too) keep reviewers from repeating them.
 * Each visit copies the OWASP Secure Agent Playbook into the worktree's scratch
 * folder, fresh, for the Security reviewer (or any reviewer) to follow.
 */
async function codeReview(
  ctx: StageContext,
  git: ReviewGit | undefined,
  stackContext: OriginContextProvider | undefined,
  prCommentsContext: OriginContextProvider | undefined,
  installPlaybook: (worktree: string) => Promise<void>,
): Promise<void> {
  const { task, run, round, repositories } = ctx;
  const reviewers = panel(task, "codeReviewers");
  if (reviewers.length === 0) return;

  let changes = "";
  let scope = "Review the changes on this branch.";
  const worktree = task.worktreePath;
  if (git) {
    if (!worktree) throw new Error("The task has no worktree");
    const range = await reviewRange(ctx, git, worktree);
    if (range) {
      const diff = await git.diff(worktree, range.from, range.to);
      if (diff.trim() === "") return;
      const command = `git diff ${range.from} ${range.to}`;
      changes =
        diff.length > MAX_REVIEW_DIFF_CHARS
          ? `${fence(diff.slice(0, MAX_REVIEW_DIFF_CHARS))}\n\n[… diff cut; run \`${command}\` for the rest]`
          : fence(diff);
      scope = [
        round === 0 || ctx.pipeline === "review"
          ? `Review the changes above (\`${command}\`): everything this branch changes.`
          : `Review the changes above (\`${command}\`): fix round ${round}, made since the last review.`,
        "Read the surrounding code as needed, but report only problems this diff introduces or leaves unfixed.",
      ].join("\n");
    }
  }

  if (worktree) await installPlaybook(worktree);

  let stack: string | undefined;
  try {
    stack = await stackContext?.(task, ctx.signal);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    // The review runs without the stack's context.
  }
  let prComments: string | undefined;
  try {
    prComments = await prCommentsContext?.(task, ctx.signal);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    // The review runs without the PR's existing comments.
  }

  const findings = repositories.findings.listByTask(task.id);
  const ignored = findings.filter((f) => f.status === "force-ignore");
  // A Review PR re-review: the user asked the reviewers to look again.
  const reported =
    ctx.pipeline === "review" && round > 0 ? findings.filter((f) => f.status === "open") : [];
  const results = await runPanel(
    ctx,
    reviewers.map((agentId) => ({
      agentId,
      prompt: prompt(
        `# Task\n\n${describeOrigin(task)}`,
        section("Details", task.freeText),
        section("Plan", task.plan),
        section("Instructions from the user", ctx.instructions),
        section("Other pull requests in the stack", stack),
        section(
          "Comments already on the pull request",
          prComments
            ? `${prComments}\n\nDo not report what these comments already raise; mention one only if you add something new.`
            : "",
        ),
        section("Changes to review", changes),
        section(
          "Findings already reported",
          reported.length > 0
            ? `${reported.map(describeFinding).join("\n")}\n\nDo not report these again; follow the user's instructions above.`
            : "",
        ),
        section(
          "Findings the user chose to ignore",
          ignored.length > 0
            ? `${ignored.map(describeFinding).join("\n")}\n\nDo not report these again.`
            : "",
        ),
        scope,
      ),
      jsonSchema: reviewOutputJsonSchema(),
    })),
  );
  const steps = repositories.steps.listByRun(run.id);
  results.forEach((result, i) => {
    const reviewerAgentId = reviewers[i]!;
    const parsed = reviewOutputSchema.safeParse(result.structured);
    if (!parsed.success) throw new Error("A reviewer returned findings in the wrong shape");
    const stepId =
      steps
        .filter(
          (s) =>
            s.stage === "code-review" && s.visit === ctx.visit && s.agentId === reviewerAgentId,
        )
        .at(-1)?.id ?? null;
    // A resumed visit reuses stored results; their findings are already saved.
    const saved = repositories.findings
      .listByTask(task.id)
      .some((f) => stepId !== null && f.stepId === stepId);
    if (saved) return;
    const created = repositories.findings.createMany(
      parsed.data.findings.map((f) => ({
        ...f,
        taskId: task.id,
        runId: run.id,
        stepId,
        reviewerAgentId,
        round,
      })),
    );
    for (const finding of created) ctx.publish({ type: "finding.upserted", payload: { finding } });
  });
}

/**
 * Aggregate: merges this round's duplicate findings (see {@link planMerges})
 * and counts what gates the loop: open Critical/High findings plus every
 * force-fixed one. Force-ignored findings never gate.
 */
async function aggregate(ctx: StageContext): Promise<StageResults["aggregate"]> {
  const { task, run, round, repositories: r } = ctx;
  const thisRound = (f: Finding) => f.runId === run.id && f.round === round;
  const all = r.findings.listByTask(task.id);
  const incoming = all.filter((f) => thisRound(f) && f.status !== "merged" && f.status !== "fixed");
  const earlier = all.filter((f) => !thisRound(f));
  for (const merge of planMerges(earlier, incoming)) {
    const target = r.findings.update(merge.targetId, merge.patch);
    ctx.publish({ type: "finding.upserted", payload: { finding: target } });
    for (const id of merge.duplicateIds) {
      const duplicate = r.findings.update(id, { status: "merged", mergedIntoId: target.id });
      ctx.publish({ type: "finding.upserted", payload: { finding: duplicate } });
    }
  }
  return { blocking: blockingFindings(r.findings.listByTask(task.id)).length };
}

/**
 * Findings left open at the summary: the Medium/Low ones below the gate, plus
 * any blocker the user accepted at an escalation. Most severe first.
 */
export function leftoverFindings(findings: readonly Finding[]): Finding[] {
  return findings
    .filter((f) => f.status === "open")
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

function describeLeftover(f: Finding): string {
  const where = f.file ? ` (\`${f.file}${f.lineStart ? `:${f.lineStart}` : ""}\`)` : "";
  return `- **[${f.severity}] ${f.title}**${where}: ${f.explanation.trim().split("\n")[0]}`;
}

const LEFT_OPEN = "\n\n### Left open\n\n";

/**
 * The summary as shown in blackwall: the summarizer's text, then the findings
 * left open (Medium/Low, or blockers accepted as is), listed by the harness so
 * none goes missing.
 */
export function finalSummary(text: string, findings: readonly Finding[]): string {
  const leftovers = leftoverFindings(findings);
  if (leftovers.length === 0) return text.trim();
  return `${text.trim()}${LEFT_OPEN}${leftovers.map(describeLeftover).join("\n")}`;
}

/** A {@link finalSummary} without the findings left open, for outbound text. */
export function withoutLeftovers(summary: string): string {
  const at = summary.indexOf(LEFT_OPEN);
  return (at === -1 ? summary : summary.slice(0, at)).trim();
}

/**
 * Summarize: the summarizer writes the final summary (changes, decisions,
 * ignored findings), a short outward summary for PR bodies and comments, a
 * commit message for the optional squash at finish and any follow-up tasks,
 * offered at finish as `create-tasks`. The harness appends the findings left
 * open to the full summary only. A reply that misses the output contract
 * still counts: its text becomes the summary. An invalid short summary is
 * stored as null and invalid follow-ups are dropped, without losing the
 * summary; each visit replaces the stored ones.
 */
async function summarize(ctx: StageContext): Promise<void> {
  const { task } = ctx;
  const findings = ctx.repositories.findings.listByTask(task.id);
  const leftovers = leftoverFindings(findings);
  const ignored = findings.filter((f) => f.status === "force-ignore");
  const key = commitKey(task);
  const result = await ctx.runAgent({
    agentId: single(task, "summarizer"),
    prompt: prompt(
      `# Task\n\n${describeOrigin(task)}`,
      section("Details", task.freeText),
      section("Plan", task.plan),
      section("Findings left open", leftovers.map(describeFinding).join("\n")),
      section("Findings the user chose to ignore", ignored.map(describeFinding).join("\n")),
      followUpsPromptSection(ctx.repositories.repos.list(), task),
      [
        "Summarize the changes on this branch for the people reviewing it: what changed, the decisions made and why, and any findings the user chose to ignore.",
        "Read the branch's commits (`git log`, `git diff`) as needed. Do not list the findings left open; the harness appends them.",
        "If the branch has no changes (the task asked for analysis or a task breakdown), summarize the analysis instead and put the work it found into `followUps`.",
        "Propose follow-up tasks only for work the plan or the analysis calls for, following the rules above; otherwise leave `followUps` empty.",
        "Also write one commit message for squashing the branch into a single commit, in the Conventional Commits format whatever style the repository's history uses: a summary line `<type>(<optional scope>): <description>` of at most 72 characters, type one of feat, fix, perf, refactor, test, docs, build, ci, style, chore, revert, description in the imperative mood; a blank line; then a short body.",
        key
          ? `Do not mention ${key} in the commit message; the harness adds it after the type prefix.`
          : "",
        "Also write `shortSummary`: a brief description for the pull request and the issue comments, in 1–3 sentences or a few bullets, of the behavioural or visual change as users or reviewers see it. Leave out implementation details (files, functions, findings, design decisions) unless the task asks for them. No headings.",
        'Reply with a JSON object `{ "summary": "<markdown>", "commitMessage": "<message>", "shortSummary": "<markdown>", "followUps": [{ "title": "<short title>", "description": "<what to do and why>", "repoId": null }] }`.',
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    jsonSchema: summaryOutputJsonSchema(),
  });
  const parsed = summaryCoreSchema.safeParse(result.structured);
  const text = parsed.success ? parsed.data.summary : result.text;
  const squash = parsed.success ? parsed.data.commitMessage : task.title;
  const short = shortSummarySchema.safeParse(result.structured);
  const structured = result.structured as { followUps?: unknown } | null | undefined;
  ctx.updateTask({
    summary: finalSummary(text, findings),
    shortSummary: short.success ? short.data.shortSummary : null,
    squashMessage: commitMessage(squash, key),
    followUps: parseFollowUps(structured?.followUps),
  });
}

/**
 * Gathers a task's origin context (the Jira issue, the PR) as markdown for
 * the Inform prompt. Runs once the worktree exists, so it can download files
 * into it; returns undefined when the origin has nothing to add.
 */
export type OriginContextProvider = (
  task: Task,
  signal: AbortSignal,
) => Promise<string | undefined>;

export interface DefaultStagesOptions {
  originContext?: OriginContextProvider;
  /**
   * A stacked PR task's other PRs and their diffs, for Code review as context
   * only; undefined for other tasks. Fetched once per visit; errors are ignored.
   */
  stackContext?: OriginContextProvider;
  /**
   * The comments already on a PR task's pull request, for Code review so
   * reviewers don't repeat them; undefined for other tasks. Fetched once per
   * visit; errors are ignored.
   */
  prCommentsContext?: OriginContextProvider;
  /** Commits each round in Checks; without it nothing is committed (tests). */
  git?: Pick<GitService, "stagedDiff" | "commitAll">;
  /** Runs one check command; defaults to the platform shell in the worktree. */
  runCheck?: CheckRunner;
  /** Scopes Code review to the round's diff; without it reviewers see the branch as it stands (tests). */
  reviewGit?: ReviewGit;
  /** Puts the security playbook in the worktree before Code review; defaults to copying the vendored one. */
  installPlaybook?: (worktree: string) => Promise<void>;
  /** Lets Checks skip a branch that changes nothing, or only Markdown and `docs/` files; without it checks always run (tests). */
  checksGit?: ChecksGit;
}

/**
 * Baseline stage handlers: each stage runs its role's agents with a plain
 * prompt, Inform adds the origin context when a provider is given, and Checks
 * commits the round and runs the repo's check commands, Code review runs the
 * panel over the round's diff (with a stacked PR's other PRs as context) and Aggregate merges duplicate findings. The
 * engine's transitions stay the same.
 */
export function createDefaultStages({
  originContext,
  stackContext,
  prCommentsContext,
  git,
  runCheck = runCheckCommand,
  reviewGit,
  installPlaybook = installSecurePlaybook,
  checksGit,
}: DefaultStagesOptions = {}): StageHandlers {
  return {
    async inform(ctx) {
      // Review PR tasks gather context only; there is no plan to write.
      if (ctx.pipeline === "review") return;
      const { task } = ctx;
      const context = await originContext?.(task, ctx.signal);
      const result = await ctx.runAgent({
        agentId: single(task, "planner"),
        prompt: prompt(
          `# Task\n\n${describeOrigin(task)}`,
          context?.trim() ?? "",
          section("Details", task.freeText),
          section("Current plan", task.plan),
          section("Requested changes to the plan", ctx.instructions),
          followUpsPromptSection(ctx.repositories.repos.list(), task),
          [
            "Read the repository and write a concrete implementation plan in markdown.",
            "Follow-up tasks are a valid deliverable. When the task asks for analysis or a task breakdown, the plan may call for no code changes; it then lists the tasks to create (title, target repo id, description), following the rules above.",
          ].join("\n"),
        ),
      });
      ctx.updateTask({ plan: result.text });
    },

    "plan-review": planReview,

    async implement(ctx) {
      const { task, repositories } = ctx;
      const toFix = blockingFindings(repositories.findings.listByTask(task.id));
      const check = checkToFix(ctx);
      const commands = repositories.repos.get(task.repoId)?.checkCommands ?? [];
      await ctx.runAgent({
        agentId: single(task, "implementer"),
        prompt: prompt(
          `# Task\n\n${describeOrigin(task)}`,
          section("Approved plan", task.plan),
          section("Findings to fix", toFix.map(describeFinding).join("\n")),
          section(
            "Failed check",
            check ? `${describeCheckFailure(check)}:\n\n${fence(check.output)}` : "",
          ),
          section("Checks the harness runs", describeCheckCommands(commands)),
          section("Instructions from the user", ctx.instructions),
          section("Worktree setup failed", ctx.setupFailure),
          ctx.setupFailure
            ? "The harness's setup commands failed, so dependencies may be missing; install what you need to work and don't change the code to work around missing packages."
            : "",
          check
            ? "Your changes fail the check above. Fix the cause in the worktree; do not weaken or skip the check."
            : toFix.length > 0
              ? "Fix the findings above in the worktree."
              : "Implement the plan in the worktree. If the approved plan calls for no code changes, change nothing.",
        ),
      });
      for (const finding of toFix) {
        // The user may have overridden it while the round ran; that override stands.
        if (repositories.findings.get(finding.id)?.status !== finding.status) continue;
        const fixed = repositories.findings.setStatus(finding.id, "fixed");
        ctx.publish({ type: "finding.upserted", payload: { finding: fixed } });
      }
    },

    checks: (ctx) => runChecks(ctx, git, runCheck, checksGit),

    "code-review": (ctx) =>
      codeReview(ctx, reviewGit, stackContext, prCommentsContext, installPlaybook),

    aggregate,

    summarize,
  };
}
