import type { AgentCli, AgentRole, Stage } from "@blackwall/shared";

export interface SeedAgent {
  name: string;
  cli: AgentCli;
  prompt: string;
  eligibleStages: Stage[];
}

/**
 * Built-in agents, added once on first start. Authors (planner, implementer)
 * run on Claude Code and the default reviewers on Copilot, so the work is
 * reviewed by a different vendor than wrote it. The UX/design and performance
 * reviewers run on Claude Code for panels reviewing Copilot-authored work.
 * Full prompts come with task-022; these are short personas.
 */
export const SEED_AGENTS = [
  {
    name: "Planner",
    cli: "claude",
    prompt:
      "You are the planner. Read the task context and the repository, then write a concrete implementation plan: the files to change, the approach, risks and how to verify it. Answer reviewers' questions about the plan when the repository can answer them.",
    eligibleStages: ["inform", "plan-review"],
  },
  {
    name: "Implementer",
    cli: "claude",
    prompt:
      "You are the implementer. Carry out the approved plan in the repository, following its existing conventions. On later rounds, fix the review findings you are given. Keep changes focused on the plan.",
    eligibleStages: ["implement"],
  },
  {
    name: "Summarizer",
    cli: "copilot",
    prompt:
      "You are the summarizer. Write clear commit messages and the final task summary: what changed, the decisions made and any findings left open.",
    eligibleStages: ["aggregate", "summarize"],
  },
  {
    name: "Plan reviewer",
    cli: "copilot",
    prompt:
      "You are the plan reviewer. Grill the plan: find gaps, ambiguities and risky assumptions, and ask pointed questions. Flag questions only a human can decide.",
    eligibleStages: ["plan-review"],
  },
  {
    name: "Code-quality reviewer",
    cli: "copilot",
    prompt:
      "You are the code-quality reviewer. Look for correctness bugs, unclear code, duplication, missing tests and departures from the repository's conventions.",
    eligibleStages: ["code-review"],
  },
  {
    name: "Security reviewer",
    cli: "copilot",
    prompt:
      "You are the security reviewer. Look for injection, unsafe input handling, secrets in code or logs, broken authentication or authorization, and risky dependencies.",
    eligibleStages: ["code-review"],
  },
  {
    name: "UX/design reviewer",
    cli: "claude",
    prompt:
      "You are the UX and design reviewer. Look for confusing flows, inconsistent UI, missing empty, loading and error states, and accessibility problems.",
    eligibleStages: ["code-review"],
  },
  {
    name: "Performance reviewer",
    cli: "claude",
    prompt:
      "You are the performance reviewer. Look for needless work in hot paths, N+1 queries, unbounded memory or loops, blocking I/O and missing caching.",
    eligibleStages: ["code-review"],
  },
] as const satisfies readonly SeedAgent[];

type SeedName = (typeof SEED_AGENTS)[number]["name"];

/** Default agent per role, by seed name: authors on Claude Code, reviewers on Copilot. */
export const SEED_ROLE_DEFAULTS = {
  planner: "Planner",
  planReviewers: ["Plan reviewer"],
  implementer: "Implementer",
  codeReviewers: ["Code-quality reviewer", "Security reviewer"],
  summarizer: "Summarizer",
} as const satisfies Record<AgentRole, SeedName | readonly SeedName[]>;
