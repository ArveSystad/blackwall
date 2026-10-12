import type { AgentCli } from "@blackwall/shared";
import { workspaceRules } from "./prompts.js";

/** The one sub-agent an implementer may start: a cheap worker for narrow jobs. */
export const SUBAGENT_NAME = "blackwall-worker";

/** CLIs whose implementers get the worker. OpenCode's subagents stay disabled. */
export const SUBAGENT_CLIS: readonly AgentCli[] = ["claude", "copilot"];

/** The tool an implementer starts the worker with, per CLI. */
export function subagentTool(cli: AgentCli): string {
  return cli === "copilot" ? "task" : "Agent";
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
