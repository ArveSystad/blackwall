import type { AgentCli, PermissionProfile } from "@blackwall/shared";
import type { OpencodePermission } from "./permissions.js";
import { workspaceRules } from "./prompts.js";

/**
 * The one sub-agent an agent step may start: a cheap worker for narrow jobs.
 * It works under the step's profile, so planners' and reviewers' worker is
 * read-only.
 */
export const SUBAGENT_NAME = "blackwall-worker";

/** CLIs whose agent steps get the worker. */
export const SUBAGENT_CLIS: readonly AgentCli[] = ["claude", "copilot", "opencode"];

/** The tool an agent starts the worker with, per CLI. */
export function subagentTool(cli: AgentCli): string {
  return cli === "claude" ? "Agent" : "task";
}

const SUBAGENT_DESCRIPTIONS: Record<PermissionProfile, string> = {
  "read-only":
    "A cheaper, faster read-only helper for narrow jobs: locating code, reading files or a reference repo and summarising them, checking git history.",
  implement:
    "A cheaper, faster helper for narrow, well-specified jobs: a mechanical edit across named files, a search, or running a build or test and reporting the result.",
};

const SUBAGENT_REPORTS: Record<PermissionProfile, string> = {
  "read-only":
    "Do only what the brief asks. When done, report briefly what you found, citing files and lines, without judging it.",
  implement:
    "Do only what the brief asks. When done, report briefly what you changed and what you ran, with its result.",
};

/** The worker's prompt for a profile, on one line. */
function subagentPrompt(profile: PermissionProfile): string {
  return [
    "You are a worker sub-agent of a senior engineer: you carry out one narrow, well-specified job.",
    workspaceRules(profile).replaceAll("\n", " "),
    SUBAGENT_REPORTS[profile],
  ].join(" ");
}

/** Claude Code tools the worker gets. No `Agent`: it cannot start sub-agents of its own. */
const CLAUDE_SUBAGENT_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["Read", "Grep", "Glob", "Bash"],
  implement: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
};

/**
 * Claude Code's `--agents` JSON defining the worker. The prompt stays on one
 * line: it goes on the command line, like `--json-schema`.
 */
export function claudeSubagents(profile: PermissionProfile): string {
  return JSON.stringify({
    [SUBAGENT_NAME]: {
      description: SUBAGENT_DESCRIPTIONS[profile],
      prompt: subagentPrompt(profile),
      tools: CLAUDE_SUBAGENT_TOOLS[profile],
      model: "haiku",
    },
  });
}

/** The model Copilot runs the worker on. */
export const COPILOT_SUBAGENT_MODEL = "claude-haiku-5.5";

/** Copilot tool aliases the worker gets. No `task`: it cannot start sub-agents of its own. */
const COPILOT_SUBAGENT_TOOLS: Record<PermissionProfile, readonly string[]> = {
  "read-only": ["read", "search", "shell"],
  implement: ["read", "search", "edit", "shell"],
};

/**
 * Copilot CLI's `<name>.agent.md` defining the worker: YAML frontmatter, then
 * the prompt. The values are JSON strings, which YAML reads as quoted scalars.
 */
export function copilotSubagentFile(profile: PermissionProfile): string {
  return [
    "---",
    `name: ${SUBAGENT_NAME}`,
    `description: ${JSON.stringify(SUBAGENT_DESCRIPTIONS[profile])}`,
    `tools: ${JSON.stringify(COPILOT_SUBAGENT_TOOLS[profile])}`,
    `model: ${COPILOT_SUBAGENT_MODEL}`,
    "---",
    subagentPrompt(profile),
    "",
  ].join("\n");
}

/**
 * The cheap model OpenCode runs the worker on, per provider of the run's
 * `provider/model` id. Other providers (or no run model) get none: the worker
 * then runs on the parent's model.
 */
const OPENCODE_SUBAGENT_MODELS = new Map([
  ["anthropic", "anthropic/claude-haiku-5-5"],
  ["github-copilot", "github-copilot/claude-haiku-5.5"],
]);

/** The model OpenCode runs the worker on for a run on `runModel`, if one is known. */
export function opencodeSubagentModel(runModel?: string): string | undefined {
  const provider = runModel?.split("/")[0];
  return provider ? OPENCODE_SUBAGENT_MODELS.get(provider) : undefined;
}

/**
 * OpenCode's agent config defining the worker: the run's permissions, with
 * `task` denied so it cannot start sub-agents of its own.
 */
export function opencodeSubagent(
  profile: PermissionProfile,
  permission: OpencodePermission,
  model?: string,
) {
  return {
    mode: "subagent" as const,
    description: SUBAGENT_DESCRIPTIONS[profile],
    prompt: subagentPrompt(profile),
    permission: { ...permission, task: "deny" as const },
    ...(model ? { model } : {}),
  };
}
