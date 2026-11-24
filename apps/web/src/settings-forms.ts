import {
  AGENT_CLIS,
  AGENT_ROLES,
  ENV_NAME_PATTERN,
  JIRA_EMAIL_META,
  MAX_GITHUB_ISSUES_REFRESH_SECONDS,
  MIN_GITHUB_ISSUES_REFRESH_SECONDS,
  PANEL_ROLES,
  ROLE_STAGES,
  cliEnvFor,
  tagNameSchema,
  type Agent,
  type AgentCli,
  type AgentInput,
  type AgentEfforts,
  type AgentModels,
  type AgentPermissionOverrides,
  type AgentRole,
  type CliEnv,
  type ConnectionInput,
  type ConnectionKind,
  type RoleAgents,
  type Stage,
  type TriageMode,
} from "@blackwall/shared";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const CLI_NAMES: Record<AgentCli, string> = {
  claude: "Claude Code",
  copilot: "Copilot CLI",
  opencode: "OpenCode",
};

/** Common models per CLI for the agent editor's picker; any other id goes in Custom. */
export const MODEL_PRESETS: Record<AgentCli, readonly string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  copilot: ["claude-sonnet-5.5", "claude-opus-5.5", "claude-haiku-5.5", "gpt-5"],
  opencode: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "openai/gpt-5"],
};

/** An example permission rule per CLI, in its own syntax, for the agent editor. */
export const OVERRIDE_EXAMPLES: Record<AgentCli, string> = {
  claude: "Bash(npm test:*)",
  copilot: "shell(npm test)",
  opencode: "bash(npm test*)",
};

export function isPresetModel(cli: AgentCli, model: string): boolean {
  return MODEL_PRESETS[cli].includes(model);
}

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

/** The agent editor's form state. List fields are edited as one item per line, per CLI. */
export interface AgentDraft {
  name: string;
  /** Model per CLI; blank runs that CLI's default model. */
  models: Record<AgentCli, string>;
  /** Reasoning effort per CLI; blank runs at that CLI's default effort. */
  efforts: Record<AgentCli, string>;
  prompt: string;
  eligibleStages: Stage[];
  allow: Record<AgentCli, string>;
  deny: Record<AgentCli, string>;
}

/** One value per CLI. */
function perCli<T>(value: (cli: AgentCli) => T): Record<AgentCli, T> {
  return Object.fromEntries(AGENT_CLIS.map((cli) => [cli, value(cli)])) as Record<AgentCli, T>;
}

export function agentDraft(agent?: Agent): AgentDraft {
  return {
    name: agent?.name ?? "",
    models: perCli((cli) => agent?.models[cli] ?? ""),
    efforts: perCli((cli) => agent?.efforts[cli] ?? ""),
    prompt: agent?.prompt ?? "",
    eligibleStages: agent ? [...agent.eligibleStages] : [],
    allow: perCli((cli) => (agent?.permissionOverrides[cli]?.allow ?? []).join("\n")),
    deny: perCli((cli) => (agent?.permissionOverrides[cli]?.deny ?? []).join("\n")),
  };
}

/**
 * The draft as an API body. A blank model means Auto, the CLI's own default,
 * and a blank effort the CLI's default effort; blank models, blank efforts and
 * CLIs without rules are left out.
 */
export function draftToInput(draft: AgentDraft): Required<AgentInput> {
  const models: AgentModels = {};
  const efforts: AgentEfforts = {};
  const permissionOverrides: AgentPermissionOverrides = {};
  for (const cli of AGENT_CLIS) {
    const model = draft.models[cli].trim();
    if (model !== "") models[cli] = model;
    const effort = draft.efforts[cli].trim();
    if (effort !== "") efforts[cli] = effort;
    const allow = parseLines(draft.allow[cli]);
    const deny = parseLines(draft.deny[cli]);
    if (allow.length > 0 || deny.length > 0) {
      permissionOverrides[cli] = {
        ...(allow.length > 0 ? { allow } : {}),
        ...(deny.length > 0 ? { deny } : {}),
      };
    }
  }
  return {
    name: draft.name.trim(),
    models,
    efforts,
    prompt: draft.prompt,
    // Keep pipeline order whatever order the boxes were ticked in.
    eligibleStages: AGENT_STAGES.map((s) => s.stage).filter((s) =>
      draft.eligibleStages.includes(s),
    ),
    permissionOverrides,
  };
}

/** How many non-blank permission rules the draft has for one CLI. */
export function overrideCount(draft: AgentDraft, cli: AgentCli): number {
  return parseLines(draft.allow[cli]).length + parseLines(draft.deny[cli]).length;
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

/** Whether a role takes a panel of agents rather than one. */
export function isPanelRole(role: AgentRole): boolean {
  return (PANEL_ROLES as readonly AgentRole[]).includes(role);
}

/** The agent ids picked for a role, as a list. */
export function roleIds(roles: RoleAgents, role: AgentRole): string[] {
  const value = roles[role];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : value;
}

/** `roles` with the role's agents set to `ids`; a single role without an id is removed. */
export function withRole(roles: RoleAgents, role: AgentRole, ids: string[]): RoleAgents {
  const next: RoleAgents = { ...roles };
  if (isPanelRole(role)) Object.assign(next, { [role]: ids });
  else if (ids[0]) Object.assign(next, { [role]: ids[0] });
  else delete next[role];
  return next;
}

export function sameRoles(a: RoleAgents, b: RoleAgents): boolean {
  return AGENT_ROLES.every((role) => roleIds(a, role).join() === roleIds(b, role).join());
}

export const TRIAGE_OPTIONS: { value: TriageMode; title: string; detail: string }[] = [
  {
    value: "intervene",
    title: "Run and let me intervene",
    detail: "Loops up to 3 fix rounds; stops for you on escalation.",
  },
  {
    value: "pause",
    title: "Pause each review round",
    detail: "You triage findings before every fix round.",
  },
];

/** A concurrency cap typed into a settings field: a whole number from 1 to 20, else null. */
export function parseCap(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
}

/** A GitHub issues refresh interval typed into a settings field: whole seconds in range, else null. */
export function parseRefreshSeconds(text: string): number | null {
  const value = Number(text);
  return text.trim() !== "" &&
    Number.isInteger(value) &&
    value >= MIN_GITHUB_ISSUES_REFRESH_SECONDS &&
    value <= MAX_GITHUB_ISSUES_REFRESH_SECONDS
    ? value
    : null;
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

/**
 * Environment variables typed as one `KEY=value` per line. Blank lines are
 * skipped; each line splits at its first `=`, the name trimmed and the value
 * kept exactly as typed. Lines without `=`, invalid names, names repeated
 * (ignoring case, as Windows does) and values wrapped in matching quotes
 * (which would reach the CLI as part of the value) are reported, by line number.
 */
export function parseEnvLines(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    const at = `Line ${index + 1}`;
    const eq = line.indexOf("=");
    if (eq === -1) {
      errors.push(`${at}: expected NAME=value`);
      return;
    }
    const name = line.slice(0, eq).trim();
    if (!ENV_NAME_PATTERN.test(name)) {
      errors.push(`${at}: "${name}" is not a variable name like MY_VAR`);
      return;
    }
    if (seen.has(name.toUpperCase())) {
      errors.push(`${at}: ${name} is set twice`);
      return;
    }
    const value = line.slice(eq + 1);
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      errors.push(`${at}: remove the quotes; values are used as typed`);
      return;
    }
    seen.add(name.toUpperCase());
    env[name] = value;
  });
  return { env, errors };
}

/** Environment variables as `parseEnvLines` reads them back. */
export function formatEnvLines(env: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

/** Whether two variable sets are equal, ignoring order. */
export function sameEnv(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  return left.length === Object.keys(right).length && left.every(([k, v]) => right[k] === v);
}

/**
 * The names of the variables a repo sets for one CLI, in the order they were
 * set; none while the repo is unknown. Names only: values never reach a tile.
 */
export function cliEnvNames(repo: { cliEnv: CliEnv } | undefined, cli: AgentCli): string[] {
  return repo ? Object.keys(cliEnvFor(repo, cli) ?? {}) : [];
}

/** An agent tile's tooltip and accessible name: the CLI, plus any custom variable names. */
export function agentTileLabel(cli: AgentCli, envNames: readonly string[]): string {
  const name = CLI_NAMES[cli];
  return envNames.length === 0 ? name : `${name} · custom env: ${envNames.join(", ")}`;
}

/** The add-connection form's state. A blank name defaults to the host; the token is optional. */
export interface ConnectionDraft {
  kind: ConnectionKind;
  name: string;
  host: string;
  email: string;
  token: string;
}

export function emptyConnectionDraft(kind: ConnectionKind = "github"): ConnectionDraft {
  return { kind, name: "", host: kind === "github" ? "github.com" : "", email: "", token: "" };
}

/** The origin for a host or URL; a bare host gets `https://`. Throws when it can't be parsed. */
export function connectionBaseUrl(host: string): string {
  const trimmed = host.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL | undefined;
  try {
    url = new URL(withScheme);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new Error("Enter a host such as github.com or a URL such as https://acme.ghe.com");
  }
  return url.origin;
}

/** The normalised host (with port) for the draft's host field, or null while it is invalid. */
export function connectionDraftHost(host: string): string | null {
  try {
    return new URL(connectionBaseUrl(host)).host;
  } catch {
    return null;
  }
}

/** The draft as an API body. Throws when the host can't be parsed. */
export function connectionDraftToInput(draft: ConnectionDraft): ConnectionInput {
  const baseUrl = connectionBaseUrl(draft.host);
  const name = draft.name.trim();
  const token = draft.token.trim();
  return {
    name: name === "" ? new URL(baseUrl).host : name,
    kind: draft.kind,
    baseUrl,
    authMeta: draft.kind === "jira" ? { [JIRA_EMAIL_META]: draft.email.trim() } : {},
    ...(token !== "" ? { token } : {}),
  };
}
