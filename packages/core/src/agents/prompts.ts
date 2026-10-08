import { SEVERITIES, type Agent, type PermissionProfile, type Stage } from "@blackwall/shared";

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
  ].join("\n"),
};

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
    "Your final answer must be a single JSON object, optionally inside a ```json fence, with nothing else:",
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
    'Return `{ "findings": [] }` when you find nothing worth reporting.',
    "",
    `Tags (use only these): ${tagList}`,
  ].join("\n");
}

export interface SystemPromptContext {
  agent: Pick<Agent, "prompt">;
  stage: Stage;
  profile: PermissionProfile;
  /** Current finding tags, in display order. */
  tags: readonly string[];
}

/**
 * The system prompt for one step: the agent's persona, the workspace rules for
 * its permission profile and, for code reviewers, the tag list and findings
 * output contract.
 */
export function buildSystemPrompt({ agent, stage, profile, tags }: SystemPromptContext): string {
  const parts = [agent.prompt.trim(), `## Workspace rules\n\n${WORKSPACE_RULES[profile]}`];
  if (stage === "code-review") parts.push(findingsContract(tags));
  return parts.filter((part) => part !== "").join("\n\n");
}
