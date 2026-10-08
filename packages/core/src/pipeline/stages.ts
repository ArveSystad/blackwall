import {
  isGatingSeverity,
  reviewOutputJsonSchema,
  reviewOutputSchema,
  type AgentRole,
  type Finding,
  type Task,
} from "@blackwall/shared";
import type { AgentResult } from "../agents/adapters/types.js";
import type { RunAgentInput, StageContext, StageHandlers } from "./engine.js";

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
 * work deepens them (grilling for Plan review, check commands, diff-scoped
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

    async "plan-review"(ctx) {
      const { task } = ctx;
      await runPanel(
        ctx,
        panel(task, "planReviewers").map((agentId) => ({
          agentId,
          prompt: prompt(
            `# Task\n\n${describeOrigin(task)}`,
            section("Plan", task.plan),
            "Review this plan against the repository. List gaps, risks and open questions.",
          ),
        })),
      );
      const openQuestions = ctx.repositories.grillQuestions
        .listByTask(task.id)
        .filter((q) => q.needsHuman && q.answer === null).length;
      return { openQuestions };
    },

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
