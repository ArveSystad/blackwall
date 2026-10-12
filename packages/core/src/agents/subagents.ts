import type { AgentCli } from "@blackwall/shared";
import type { OpencodePermission } from "./permissions.js";
import { workspaceRules } from "./prompts.js";

/** The one sub-agent an implementer may start: a cheap worker for narrow jobs. */
export const SUBAGENT_NAME = "blackwall-worker";

/** CLIs whose implementers get the worker. */
export const SUBAGENT_CLIS: readonly AgentCli[] = ["claude", "copilot", "opencode"];

/** The tool an implementer starts the worker with, per CLI. */
export function subagentTool(cli: AgentCli): string {
  return cli === "claude" ? "Agent" : "task";
}

const SUBAGENT_DESCRIPTION =
  "A cheaper, faster helper for narrow, well-specified jobs: a mechanical edit across named files, a search, or running a build or test and reporting the result.";

/** The worker's prompt, on one line. */
function subagentPrompt(): string {
  return [
    "You are a worker sub-agent of a senior engineer: you carry out one narrow, well-specified job.",
    workspaceRules("implement").replaceAll("\n", " "),
    "Do only what the brief asks. When done, report briefly what you changed and what you ran, with its result.",
  ].join(" ");
}

/** Claude Code tools the worker gets. No `Agent`: it cannot start sub-agents of its own. */
const CLAUDE_SUBAGENT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;

/**
 * Claude Code's `--agents` JSON defining the worker. The prompt stays on one
 * line: it goes on the command line, like `--json-schema`.
 */
export function claudeSubagents(): string {
  return JSON.stringify({
    [SUBAGENT_NAME]: {
      description: SUBAGENT_DESCRIPTION,
      prompt: subagentPrompt(),
      tools: CLAUDE_SUBAGENT_TOOLS,
      model: "haiku",
    },
  });
}

/** The model Copilot runs the worker on. */
export const COPILOT_SUBAGENT_MODEL = "claude-haiku-5.5";

/** Copilot tool aliases the worker gets. No `task`: it cannot start sub-agents of its own. */
const COPILOT_SUBAGENT_TOOLS = ["read", "search", "edit", "shell"] as const;

/**
 * Copilot CLI's `<name>.agent.md` defining the worker: YAML frontmatter, then
 * the prompt. The values are JSON strings, which YAML reads as quoted scalars.
 */
export function copilotSubagentFile(): string {
  return [
    "---",
    `name: ${SUBAGENT_NAME}`,
    `description: ${JSON.stringify(SUBAGENT_DESCRIPTION)}`,
    `tools: ${JSON.stringify(COPILOT_SUBAGENT_TOOLS)}`,
    `model: ${COPILOT_SUBAGENT_MODEL}`,
    "---",
    subagentPrompt(),
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
export function opencodeSubagent(permission: OpencodePermission, model?: string) {
  return {
    mode: "subagent" as const,
    description: SUBAGENT_DESCRIPTION,
    prompt: subagentPrompt(),
    permission: { ...permission, task: "deny" as const },
    ...(model ? { model } : {}),
  };
}
