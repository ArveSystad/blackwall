import {
  ROLE_STAGES,
  tagNameSchema,
  type Agent,
  type AgentCli,
  type AgentInput,
  type AgentRole,
  type Stage,
} from "@blackwall/shared";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const CLI_NAMES: Record<AgentCli, string> = {
  claude: "Claude Code",
  copilot: "Copilot CLI",
};

/** Stages an agent can be eligible for, with their labels. Checks run in the harness, not an agent. */
export const AGENT_STAGES = [
  { stage: "inform", label: "Inform" },
  { stage: "plan-review", label: "Plan review" },
  { stage: "implement", label: "Implement" },
  { stage: "code-review", label: "Code review" },
  { stage: "aggregate", label: "Aggregate" },
  { stage: "summarize", label: "Summarize" },
] as const satisfies readonly { stage: Stage; label: string }[];

export function stageLabel(stage: Stage): string {
  return AGENT_STAGES.find((s) => s.stage === stage)?.label ?? stage;
}

/** Role labels for the Defaults section, in pipeline order. */
export const ROLE_LABELS: Record<AgentRole, string> = {
  planner: "Planner",
  planReviewers: "Plan reviewers",
  implementer: "Implementer",
  codeReviewers: "Code reviewers",
  summarizer: "Summarizer",
};

/** Non-empty trimmed lines; used for check commands and permission rules. */
export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** The agent editor's form state. List fields are edited as one item per line. */
export interface AgentDraft {
  name: string;
  cli: AgentCli;
  model: string;
  prompt: string;
  eligibleStages: Stage[];
  allow: string;
  deny: string;
}

export function agentDraft(agent?: Agent): AgentDraft {
  return {
    name: agent?.name ?? "",
    cli: agent?.cli ?? "claude",
    model: agent?.model ?? "",
    prompt: agent?.prompt ?? "",
    eligibleStages: agent ? [...agent.eligibleStages] : [],
    allow: (agent?.permissionOverrides.allow ?? []).join("\n"),
    deny: (agent?.permissionOverrides.deny ?? []).join("\n"),
  };
}

/** The draft as an API body. A blank model means the CLI's default. */
export function draftToInput(draft: AgentDraft): Required<AgentInput> {
  const allow = parseLines(draft.allow);
  const deny = parseLines(draft.deny);
  return {
    name: draft.name.trim(),
    cli: draft.cli,
    model: draft.model.trim() === "" ? null : draft.model.trim(),
    prompt: draft.prompt,
    // Keep pipeline order whatever order the boxes were ticked in.
    eligibleStages: AGENT_STAGES.map((s) => s.stage).filter((s) =>
      draft.eligibleStages.includes(s),
    ),
    permissionOverrides: {
      ...(allow.length > 0 ? { allow } : {}),
      ...(deny.length > 0 ? { deny } : {}),
    },
  };
}

/** Whether two drafts would save the same agent. */
export function sameDraft(a: AgentDraft, b: AgentDraft): boolean {
  return JSON.stringify(draftToInput(a)) === JSON.stringify(draftToInput(b));
}

/** A free name for a copy: "X (copy)", then "X (copy 2)", … */
export function copyName(name: string, taken: readonly string[]): string {
  const names = new Set(taken);
  let candidate = `${name} (copy)`;
  for (let n = 2; names.has(candidate); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

/** Agents that can fill a role: eligible for the role's stage. */
export function agentsForRole(agents: readonly Agent[], role: AgentRole): Agent[] {
  return agents.filter((a) => a.eligibleStages.includes(ROLE_STAGES[role]));
}

export type TagEdit = { ok: true; tags: string[] } | { ok: false; error: string };

/** Adds a tag to the end of the list; spaces and underscores become hyphens. */
export function addTag(tags: readonly string[], raw: string): TagEdit {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const parsed = tagNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Bad tag" };
  if (tags.includes(parsed.data)) return { ok: false, error: `${parsed.data} is already listed` };
  return { ok: true, tags: [...tags, parsed.data] };
}

/** Moves the item at `index` by `delta` places, clamped to the list. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const next = [...list];
  const target = Math.max(0, Math.min(list.length - 1, index + delta));
  const [item] = next.splice(index, 1);
  if (item !== undefined) next.splice(target, 0, item);
  return next;
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}
