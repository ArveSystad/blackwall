import {
  MAX_GRILL_ROUNDS,
  isGatingSeverity,
  planAnswersOutputJsonSchema,
  planAnswersOutputSchema,
  planReviewOutputJsonSchema,
  planReviewOutputSchema,
  reviewOutputJsonSchema,
  reviewOutputSchema,
  type AgentRole,
  type Finding,
  type GrillQuestion,
  type Step,
  type Task,
} from "@blackwall/shared";
import type { AgentResult } from "../agents/adapters/types.js";
import type { RunAgentInput, StageContext, StageHandlers } from "./engine.js";
import type { StageResults } from "./transitions.js";

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

/** Findings the next fix round must address: open Critical/High ones and any the user force-fixed. */
export function blockingFindings(findings: readonly Finding[]): Finding[] {
  return findings.filter(
    (f) => f.status === "force-fix" || (f.status === "open" && isGatingSeverity(f.severity)),
  );
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
      return `Jira issue ${origin.key}: ${task.title}`;
    case "github-pr":
      return `Pull request ${origin.owner}/${origin.repo}#${origin.number}: ${task.title}`;
    case "free-text":
      return task.title;
  }
}

function describeFinding(f: Finding): string {
  const where = f.file ? ` (${f.file}${f.lineStart ? `:${f.lineStart}` : ""})` : "";
  const fix = f.suggestedFix ? `\n  Suggested fix: ${f.suggestedFix}` : "";
  return `- [${f.severity}] ${f.title}${where}\n  ${f.explanation}${fix}`;
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
        "Answer each question not marked (for the user) from the repository, by its number.",
        "Answer null when only the user can decide; do not guess product or scope decisions.",
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
    // Questions flagged for a human are the user's to decide, never the planner's.
    if (q.needsHuman) return;
    const answer = answers.get(i + 1) ?? null;
    const saved =
      answer === null
        ? repositories.grillQuestions.markNeedsHuman(q.id)
        : repositories.grillQuestions.answer(q.id, answer, "agent");
    ctx.publish({ type: "grill.upserted", payload: { question: saved } });
  });
  ctx.updateTask({ plan: parsed.data.plan });
  return { openQuestions: open(), satisfied: false };
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
}

/**
 * Baseline stage handlers: each stage runs its role's agents with a plain
 * prompt, and Inform adds the origin context when a provider is given. Later
 * work deepens them (check commands, diff-scoped
 * reviews and aggregation, delivery); the engine's transitions stay the same.
 */
export function createDefaultStages({ originContext }: DefaultStagesOptions = {}): StageHandlers {
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
          "Read the repository and write a concrete implementation plan in markdown.",
        ),
      });
      ctx.updateTask({ plan: result.text });
    },

    "plan-review": planReview,

    async implement(ctx) {
      const { task, repositories } = ctx;
      const toFix = blockingFindings(repositories.findings.listByTask(task.id));
      await ctx.runAgent({
        agentId: single(task, "implementer"),
        prompt: prompt(
          `# Task\n\n${describeOrigin(task)}`,
          section("Approved plan", task.plan),
          section("Findings to fix", toFix.map(describeFinding).join("\n")),
          section("Instructions from the user", ctx.instructions),
          toFix.length > 0
            ? "Fix the findings above in the worktree."
            : "Implement the plan in the worktree.",
        ),
      });
      for (const finding of toFix) {
        const fixed = repositories.findings.setStatus(finding.id, "fixed");
        ctx.publish({ type: "finding.upserted", payload: { finding: fixed } });
      }
    },

    async checks() {
      return { retryImplement: false };
    },

    async "code-review"(ctx) {
      const { task, run, round, repositories } = ctx;
      const reviewers = panel(task, "codeReviewers");
      const results = await runPanel(
        ctx,
        reviewers.map((agentId) => ({
          agentId,
          prompt: prompt(
            `# Task\n\n${describeOrigin(task)}`,
            section("Plan", task.plan),
            "Review the changes on this branch.",
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
        for (const finding of created)
          ctx.publish({ type: "finding.upserted", payload: { finding } });
      });
    },

    async aggregate(ctx) {
      const findings = ctx.repositories.findings.listByTask(ctx.task.id);
      return { blocking: blockingFindings(findings).length };
    },

    async summarize(ctx) {
      const { task } = ctx;
      const leftovers = ctx.repositories.findings
        .listByTask(task.id)
        .filter((f) => f.status === "open");
      await ctx.runAgent({
        agentId: single(task, "summarizer"),
        prompt: prompt(
          `# Task\n\n${describeOrigin(task)}`,
          section("Plan", task.plan),
          section("Findings left open", leftovers.map(describeFinding).join("\n")),
          "Summarize the changes on this branch, the decisions made and the findings left open.",
        ),
      });
    },
  };
}
