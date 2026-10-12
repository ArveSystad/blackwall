import { workspaceRules } from "./prompts.js";

/** The one sub-agent an implementer may start: a cheap worker for narrow jobs. */
export const SUBAGENT_NAME = "blackwall-worker";

/** Tools the worker gets. No `Agent`: it cannot start sub-agents of its own. */
const SUBAGENT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;

/**
 * Claude Code's `--agents` JSON defining the worker. The prompt stays on one
 * line: it goes on the command line, like `--json-schema`.
 */
export function claudeSubagents(): string {
  const prompt = [
    "You are a worker sub-agent of a senior engineer: you carry out one narrow, well-specified job.",
    workspaceRules("implement").replaceAll("\n", " "),
    "Do only what the brief asks. When done, report briefly what you changed and what you ran, with its result.",
  ].join(" ");
  return JSON.stringify({
    [SUBAGENT_NAME]: {
      description:
        "A cheaper, faster helper for narrow, well-specified jobs: a mechanical edit across named files, a search, or running a build or test and reporting the result.",
      prompt,
      tools: SUBAGENT_TOOLS,
      model: "haiku",
    },
  });
}
