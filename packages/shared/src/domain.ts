import { z } from "zod";

/*
 * Domain model shared by core, server and web. Each entity has one zod schema;
 * its TypeScript type is inferred from it. Timestamps are `Date`s in memory and
 * ISO strings on the wire; `z.coerce.date()` accepts both.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CONNECTION_KINDS = ["github", "jira"] as const;
export const AGENT_CLIS = ["claude", "copilot", "opencode"] as const;
export const ORIGIN_KINDS = ["jira-issue", "github-pr", "github-issue", "free-text"] as const;
/** How a GitHub PR task treats the PR: work on it, or only review it. */
export const PR_MODES = ["work", "review"] as const;
/** `intervene`: run and let the user intervene. `pause`: pause before each fix round. */
export const TRIAGE_MODES = ["intervene", "pause"] as const;
export const TASK_STATUSES = [
  "queued",
  "running",
  "needs-you",
  "interrupted",
  "failed",
  "done",
] as const;
/**
 * The `error` of an `interrupted` task the user stopped, which tells a stop
 * apart from a shutdown (no error) or a usage limit (the limit's message).
 */
export const TASK_STOPPED_ERROR = "Stopped by you";
/** The `error` of a task a data import found `running` or `queued` and made `interrupted`. */
export const IMPORT_INTERRUPTED_ERROR = "Interrupted by a data import";
/**
 * `waiting`: eligible to run. `promoted`: turned into a task (`taskId`).
 * `paused`: the user held it back.
 */
export const BACKLOG_STATUSES = ["waiting", "promoted", "paused"] as const;
/** Pipeline stages, in order. */
export const STAGES = [
  "inform",
  "plan-review",
  "implement",
  "checks",
  "code-review",
  "aggregate",
  "summarize",
] as const;
export const STEP_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
/**
 * What a `needs-you` task waits on. `questions`: grill questions only a human
 * can answer. `plan-approval`: approve the plan before any code is touched.
 * `triage`: triage findings (pause-each-round mode, or before posting a PR
 * review). `escalation`: the review loop hit its round cap. `finish`: confirm
 * the delivery actions.
 */
export const GATES = ["questions", "plan-approval", "triage", "escalation", "finish"] as const;
/**
 * The user's answer at a gate. `approve` moves on (approve the plan, accept the
 * code as is after an escalation, deliver at finish). `revise` sends the work
 * back (re-plan, or one more fix round), with the message as instructions.
 */
export const GATE_DECISIONS = ["approve", "revise"] as const;
/** Fix rounds in the code review loop before the task escalates to the user. */
export const MAX_FIX_ROUNDS = 3;
/**
 * Grill rounds in Plan review before the plan goes to the user for approval,
 * even if the reviewers still have questions.
 */
export const MAX_GRILL_ROUNDS = 3;
/**
 * Implementer retries per fix round when a check command fails, before the
 * failure becomes a Critical `correctness` finding for the review panel.
 */
export const MAX_CHECK_RETRIES = 1;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
/** Severities that block the code review loop. */
export const GATING_SEVERITIES = ["critical", "high"] as const satisfies readonly Severity[];
/**
 * `open`: reported, not yet fixed. `fixed`: a fix round addressed it.
 * `force-fix` / `force-ignore`: the user's override. `merged`: a duplicate the
 * aggregation step folded into another finding (`mergedIntoId`).
 */
export const FINDING_STATUSES = ["open", "fixed", "force-fix", "force-ignore", "merged"] as const;
/** Finding statuses the user can set by hand. */
export const FINDING_OVERRIDES = ["force-fix", "force-ignore"] as const;
export const GRILL_ANSWERERS = ["agent", "user"] as const;
/**
 * Delivery actions offered at finish, in the order they run. Agents never
 * perform these themselves; the harness does, and only the ones the user
 * confirmed. `merge-main` is the free-text finish (rebase onto local main,
 * then fast-forward it); it never leaves the machine and main is never pushed.
 * A free-text task does either `merge-main` or `push-branch` + `open-pr`,
 * never both, and never `merge-main` once its branch was pushed.
 * `issue-comment` comments on a GitHub issue task's issue. `create-tasks`
 * creates the selected follow-up tasks as independent waiting backlog items;
 * local only. It runs last, so follow-ups branch from a main that already has
 * this task's merge.
 */
export const DELIVERY_TARGETS = [
  "push-branch",
  "open-pr",
  "pr-comment",
  "jira-comment",
  "issue-comment",
  "merge-main",
  "pr-review",
  "create-tasks",
] as const;
/** Seed list for the editable finding tags. */
export const DEFAULT_TAGS = [
  "security",
  "correctness",
  "ux",
  "accessibility",
  "design",
  "performance",
  "code-quality",
  "maintainability",
  "architecture",
  "testing",
  "error-handling",
  "concurrency",
  "data",
  "api-contract",
  "dependencies",
  "config",
  "observability",
  "documentation",
  "spelling",
  "i18n",
  "plan-deviation",
  "scope-creep",
] as const;

/**
 * What a repo lets its agents load. `locked`: the harness sandbox only, with no
 * repo or user config. `trusted`: also the repo's own skills, sub-agents and
 * instruction files (project MCP servers and hooks only when turned on, and only
 * for implement steps); read-only steps keep exactly Locked's tool permissions.
 * `unrestricted`: each CLI's full "yolo" mode, with no rules at all.
 */
export const AGENT_TRUST_LEVELS = ["locked", "trusted", "unrestricted"] as const;
/**
 * Whether a GitHub PR task's branch holds only the user's own commits.
 * `unchecked`: not checked yet, or the check failed. `owned`: the PR is the
 * user's, from the base repo, and every commit is theirs. `foreign`: anything
 * else. Only `owned` lets a PR task run above Locked.
 */
export const PR_BRANCH_STATES = ["unchecked", "owned", "foreign"] as const;

export const connectionKindSchema = z.enum(CONNECTION_KINDS);
export const agentCliSchema = z.enum(AGENT_CLIS);
export const originKindSchema = z.enum(ORIGIN_KINDS);
export const prModeSchema = z.enum(PR_MODES);
export const triageModeSchema = z.enum(TRIAGE_MODES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const stageSchema = z.enum(STAGES);
export const stepStatusSchema = z.enum(STEP_STATUSES);
export const gateSchema = z.enum(GATES);
export const gateDecisionSchema = z.enum(GATE_DECISIONS);
export const severitySchema = z.enum(SEVERITIES);
export const findingStatusSchema = z.enum(FINDING_STATUSES);
export const findingOverrideSchema = z.enum(FINDING_OVERRIDES);
export const grillAnswererSchema = z.enum(GRILL_ANSWERERS);
export const deliveryTargetSchema = z.enum(DELIVERY_TARGETS);
export const backlogStatusSchema = z.enum(BACKLOG_STATUSES);
export const agentTrustLevelSchema = z.enum(AGENT_TRUST_LEVELS);
export const prBranchSchema = z.enum(PR_BRANCH_STATES);

export type AgentTrustLevel = z.infer<typeof agentTrustLevelSchema>;
export type PrBranch = z.infer<typeof prBranchSchema>;

export type ConnectionKind = z.infer<typeof connectionKindSchema>;
export type AgentCli = z.infer<typeof agentCliSchema>;
export type OriginKind = z.infer<typeof originKindSchema>;
export type PrMode = z.infer<typeof prModeSchema>;
export type TriageMode = z.infer<typeof triageModeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type StepStatus = z.infer<typeof stepStatusSchema>;
export type Gate = z.infer<typeof gateSchema>;
export type GateDecision = z.infer<typeof gateDecisionSchema>;
export type Severity = z.infer<typeof severitySchema>;
export type FindingStatus = z.infer<typeof findingStatusSchema>;
export type FindingOverride = z.infer<typeof findingOverrideSchema>;
export type GrillAnswerer = z.infer<typeof grillAnswererSchema>;
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export type BacklogStatus = z.infer<typeof backlogStatusSchema>;

export function isGatingSeverity(severity: Severity): boolean {
  return (GATING_SEVERITIES as readonly Severity[]).includes(severity);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const id = z.string().min(1);
const timestamp = z.coerce.date();
const name = z.string().trim().min(1);

/** Longest task or backlog item title. */
export const MAX_TITLE_CHARS = 120;

export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

/** A Jira project key (`ABC`): the part of an issue key before the dash. */
export const JIRA_PROJECT_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// CI
// ---------------------------------------------------------------------------

/**
 * Where the watch of a pushed commit's CI stands: `pending` while checks run,
 * `none` when no checks appeared, `timed-out` past the watch's cap and
 * `unavailable` when the token can't read them.
 */
export const CI_STATES = [
  "pending",
  "passed",
  "failed",
  "timed-out",
  "none",
  "unavailable",
] as const;
export const ciStateSchema = z.enum(CI_STATES);
export type CiState = z.infer<typeof ciStateSchema>;

export const CI_CHECK_STATES = ["pending", "passed", "failed", "skipped"] as const;

/** One check on the pushed commit: a check run (GitHub Actions, apps) or a commit status. */
export const ciCheckSchema = z.object({
  name: z.string(),
  kind: z.enum(["check-run", "status"]),
  /** The check run's or status's id; for GitHub Actions the check run id is the job id. */
  id: z.number(),
  state: z.enum(CI_CHECK_STATES),
  /** GitHub's conclusion (check runs) or state (statuses); null while running. */
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});
export type CiCheck = z.infer<typeof ciCheckSchema>;

/**
 * CI on the commit a task last pushed. Timestamps are ISO strings: the column
 * is JSON, which does not turn them back into Dates.
 */
export const taskCiSchema = z.object({
  state: ciStateSchema,
  sha: z.string(),
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  checks: z.array(ciCheckSchema),
  /** Why CI can't be read fully (token scope, SSO, no token); null when it can. */
  hint: z.string().nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type TaskCi = z.infer<typeof taskCiSchema>;

/** Hint when the token for `host` lacks the scopes to read check runs or statuses. */
export function ciScopeHint(host: string): string {
  return `The token for ${host} can't read check runs. Give it Checks: read and Commit statuses: read (fine-grained) or \`repo\` (classic) to see CI here.`;
}

/** Hint when the token for `host` is not authorised for the organisation's SAML SSO. */
export function ciSsoHint(host: string): string {
  return `The token for ${host} isn't authorised for SAML SSO. Authorise it under Settings → Tokens → Configure SSO to see CI here.`;
}

/** Hint when blackwall has no token for `host`. */
export function ciMissingTokenHint(host: string): string {
  return `There is no token for ${host}. Add one under Settings → Connections to see CI here.`;
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

/** Most follow-up tasks kept from one summary. */
export const MAX_FOLLOW_UPS = 5;

/** A follow-up as the summarizer sends it; no length caps, so the CLI never rejects the reply for one. */
export const followUpWireSchema = z.object({
  title: z.string(),
  description: z.string(),
  /** Registered repo id it belongs in; null for the task's own repo. */
  repoId: z.string().nullable(),
});

/** A follow-up task the summarizer proposed, created at finish only if the user confirms it. */
export const followUpSchema = z.object({
  title: name.max(MAX_TITLE_CHARS),
  description: z.string().trim().min(1),
  /** Registered repo id it belongs in; null for the task's own repo. */
  repoId: z.string().trim().min(1).nullable(),
});
export type FollowUp = z.infer<typeof followUpSchema>;

/**
 * The valid follow-ups of a summarizer's reply: anything but an array gives
 * none, invalid entries are dropped, unknown keys stripped, and at most
 * {@link MAX_FOLLOW_UPS} kept.
 */
export function parseFollowUps(raw: unknown): FollowUp[] {
  if (!Array.isArray(raw)) return [];
  const valid: FollowUp[] = [];
  for (const entry of raw) {
    const parsed = followUpSchema.safeParse(entry);
    if (parsed.success) valid.push(parsed.data);
  }
  return valid.slice(0, MAX_FOLLOW_UPS);
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

/**
 * What a memory is about: a convention to follow, a pitfall to avoid, a
 * decision the user made, a command to run, or background context.
 */
export const MEMORY_KINDS = ["convention", "pitfall", "decision", "command", "context"] as const;
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** Longest memory text. */
export const MAX_MEMORY_CHARS = 500;

/** Most memories kept from one summary. */
export const MAX_MEMORIES_PER_TASK = 5;

/**
 * A lasting fact about a repo, saved by the summarizer and shown to later
 * tasks and chats in that repo. Notes from reviews of someone else's pull
 * request are held (`awaitingMerge`) until it merges into the repo's default
 * branch.
 */
export const memorySchema = z.object({
  id,
  repoId: id,
  /** The task that saved it; null once that task is deleted. */
  sourceTaskId: id.nullable(),
  kind: memoryKindSchema,
  text: z.string().trim().min(1).max(MAX_MEMORY_CHARS),
  /** Repo-relative paths it is about; null when none. */
  files: z.array(z.string().min(1)).nullable(),
  /** Always included in prompts, ahead of the search matches. */
  pinned: z.boolean(),
  /** Held until the reviewed pull request merges into the repo's default branch. */
  awaitingMerge: z.boolean(),
  /** When the user last edited it; null if never. Edited notes are never replaced. */
  editedAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Memory = z.infer<typeof memorySchema>;

/** A memory to save. */
export const memoryInputSchema = z.object({
  kind: memoryKindSchema,
  text: z.string().trim().min(1).max(MAX_MEMORY_CHARS),
  files: z.array(z.string().trim().min(1)).nullable().optional(),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;

/** A `PATCH /api/repos/:repoId/memories/:id` body; any change marks the note edited. */
export const memoryUpdateSchema = z.object({
  kind: memoryKindSchema.optional(),
  text: memorySchema.shape.text.optional(),
  files: z.array(z.string().trim().min(1)).nullable().optional(),
  pinned: z.boolean().optional(),
});
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

/** A repo's notes: the active ones (pinned first, then newest) and the held ones (newest first). */
export const repoMemoriesSchema = z.object({
  memories: memorySchema.array(),
  awaitingMerge: memorySchema.array(),
});
export type RepoMemories = z.infer<typeof repoMemoriesSchema>;

/** A memory as the summarizer sends it; no caps, so the CLI never rejects the reply for one. */
export const memoryWireSchema = z.object({
  kind: z.string(),
  text: z.string(),
  files: z.array(z.string()).nullable().optional(),
});

/**
 * The valid memories of a summarizer's reply: anything but an array gives
 * none, invalid entries are dropped, empty `files` become null, and at most
 * {@link MAX_MEMORIES_PER_TASK} kept.
 */
export function parseMemories(raw: unknown): MemoryInput[] {
  if (!Array.isArray(raw)) return [];
  const valid: MemoryInput[] = [];
  for (const entry of raw) {
    const parsed = memoryInputSchema.safeParse(entry);
    if (!parsed.success) continue;
    const files = parsed.data.files?.length ? parsed.data.files : null;
    valid.push({ ...parsed.data, files });
  }
  return valid.slice(0, MAX_MEMORIES_PER_TASK);
}

// ---------------------------------------------------------------------------
// Connections, repos, agents, tags, settings
// ---------------------------------------------------------------------------

/** A GitHub.com/GHE host or Jira Cloud site. The token lives in the OS keychain, never here. */
export const connectionSchema = z.object({
  id,
  name,
  kind: connectionKindSchema,
  baseUrl: z.url(),
  /** Non-secret auth metadata, e.g. the Jira account email. */
  authMeta: z.record(z.string(), z.string()),
  /** Whether a token is stored in the keychain. */
  tokenSet: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Connection = z.infer<typeof connectionSchema>;

/**
 * A connection as the API returns it. Carries only whether a token is available
 * (keychain or env override), never the token itself.
 */
export const connectionViewSchema = connectionSchema
  .omit({ tokenSet: true })
  .extend({ hasToken: z.boolean() })
  .strict();
export type ConnectionView = z.infer<typeof connectionViewSchema>;

/** `authMeta` key holding the Jira Cloud account email (Basic auth is email + API token). */
export const JIRA_EMAIL_META = "email";

const secret = z.string().trim().min(1);

type ConnectionAuth = { kind: ConnectionKind; authMeta: Record<string, string> };

/** Why a connection's auth metadata is incomplete (Jira needs the account email), if it is. */
export function connectionAuthProblem({ kind, authMeta }: ConnectionAuth): string | undefined {
  if (kind === "jira" && !z.email().safeParse(authMeta[JIRA_EMAIL_META]).success) {
    return "Jira connections need the account email";
  }
  return undefined;
}

function checkConnectionAuth(value: ConnectionAuth, ctx: z.RefinementCtx): void {
  const message = connectionAuthProblem(value);
  if (message) ctx.addIssue({ code: "custom", path: ["authMeta", JIRA_EMAIL_META], message });
}

/** Body for creating a connection; `token`, when given, goes straight to the keychain. */
export const connectionInputSchema = connectionSchema
  .pick({ name: true, kind: true, baseUrl: true })
  .extend({ authMeta: connectionSchema.shape.authMeta.default({}), token: secret.optional() })
  .superRefine(checkConnectionAuth);
export type ConnectionInput = z.input<typeof connectionInputSchema>;

/** Body for editing a connection. The kind is fixed once created. */
export const connectionUpdateSchema = z.object({
  name: connectionSchema.shape.name.optional(),
  baseUrl: connectionSchema.shape.baseUrl.optional(),
  authMeta: connectionSchema.shape.authMeta.optional(),
});
export type ConnectionUpdate = z.infer<typeof connectionUpdateSchema>;

/** Body for storing a connection's token in the keychain. */
export const tokenInputSchema = z.object({ token: secret });
export type TokenInput = z.infer<typeof tokenInputSchema>;

/** Outcome of "Test connection" (GitHub `GET /user`, Jira `GET /rest/api/3/myself`). */
export const connectionTestResultSchema = z.discriminatedUnion("ok", [
  /** `account` is the GitHub login or the Jira display name. */
  z.object({ ok: z.literal(true), account: z.string() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

/** Finds the connection for a git remote (GitHub/GHE) or a Jira URL. */
export const resolveConnectionInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), remote: z.string().trim().min(1) }),
  z.object({ kind: z.literal("jira"), url: z.url() }),
]);
export type ResolveConnectionInput = z.infer<typeof resolveConnectionInputSchema>;

/** How many backlog tasks may run at once in one repo. */
export const backlogCapSchema = z.int().min(1).max(20);

/** A repo's default branch when none is configured. */
export const DEFAULT_BRANCH = "main";

/**
 * A local branch name, roughly as `git check-ref-format --branch` allows. Refuses
 * anything git would read as an option (a leading `-`) or a full ref (`refs/…`).
 */
export const branchNameSchema = z
  .string()
  .trim()
  .min(1, "Branch name can't be empty")
  .max(255)
  .refine(
    (b) =>
      !/[\s~^:?*[\\]/.test(b) &&
      !b.includes("..") &&
      !b.includes("@{") &&
      !/^[-/]/.test(b) &&
      !/(\/|\.lock|\.)$/.test(b) &&
      !b.includes("//") &&
      !b.startsWith("refs/"),
    "Not a valid branch name",
  );

export const repoSchema = z.object({
  id,
  /** Absolute path of the local git repo. */
  path: z.string().min(1),
  name,
  remoteUrl: z.string().nullable(),
  connectionId: id.nullable(),
  /** Build/test commands run in the Checks stage; empty = skip. */
  checkCommands: z.array(z.string().trim().min(1)),
  /** Commands run in each task worktree before agents work (dependency install); empty = no setup. */
  setupCommands: z.array(z.string().trim().min(1)),
  /** CLI new tasks in this repo run their agents on. */
  defaultCli: agentCliSchema,
  /** Origin the new-task and backlog forms open on for this repo. */
  defaultOrigin: originKindSchema,
  /** Backlog tasks running at once in this repo; null uses the global setting. */
  maxBacklogTasks: backlogCapSchema.nullable(),
  /** Branch new tasks fork from, free-text tasks merge into, PRs target and the Backlog pushes. */
  defaultBranch: branchNameSchema,
  /** Listed first, with a star. */
  favorite: z.boolean(),
  /** Manual order among repos in the same favourite group. */
  position: z.int(),
  /** Watch CI after a task pushes its branch; matters only for GitHub/GHE remotes. */
  watchCi: z.boolean(),
  /** Jira project key whose open issues the Backlog lists; null = none. */
  jiraProject: z
    .string()
    .regex(JIRA_PROJECT_PATTERN, "Expected a Jira project key like ABC")
    .nullable(),
  /**
   * Other registered repos whose files the read-only agents (planner, reviewers,
   * summarizer) and the chat may read. Implementers stay in the worktree.
   */
  referenceRepoIds: z.array(id),
  /** What the repo's agents may load and do; see {@link AGENT_TRUST_LEVELS}. */
  agentTrust: agentTrustLevelSchema,
  /** Trusted only: implement steps also start the repo's project MCP servers. */
  trustProjectMcp: z.boolean(),
  /** Trusted only: implement steps also run the repo's project hooks (OpenCode: plugins). */
  trustProjectHooks: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Repo = z.infer<typeof repoSchema>;

/** A registry repo as the API returns it, with whether its folder still exists. */
export const repoViewSchema = repoSchema.extend({ exists: z.boolean() });
export type RepoView = z.infer<typeof repoViewSchema>;

/** The repo's local default branch vs `origin/<branch>`, as of the last fetch. */
export const repoSyncSchema = z.object({
  branch: z.string().min(1),
  /** Local commits `origin/<branch>` doesn't have. */
  ahead: z.int().min(0),
  /** `origin/<branch>` commits the local branch doesn't have. */
  behind: z.int().min(0),
});
export type RepoSync = z.infer<typeof repoSyncSchema>;

/** Body for registering one repo. */
export const repoInputSchema = z.object({
  path: z.string().trim().min(1),
  /** Defaults to the folder name. */
  name: name.optional(),
  /** Omitted: suggested from the repo's build files. Empty: Checks are skipped. */
  checkCommands: repoSchema.shape.checkCommands.optional(),
  /** Omitted: suggested from the repo's lockfiles. Empty: no setup. */
  setupCommands: repoSchema.shape.setupCommands.optional(),
});
export type RepoInput = z.input<typeof repoInputSchema>;

/** A list of reference repo ids, as the user picks them. */
const referenceRepoIdsSchema = z
  .array(id)
  .refine((ids) => new Set(ids).size === ids.length, "Each repo can be listed only once");

/** Body for editing a repo. The path is fixed once registered. */
export const repoUpdateSchema = z.object({
  name: name.optional(),
  checkCommands: repoSchema.shape.checkCommands.optional(),
  setupCommands: repoSchema.shape.setupCommands.optional(),
  defaultCli: agentCliSchema.optional(),
  defaultOrigin: originKindSchema.optional(),
  maxBacklogTasks: backlogCapSchema.nullable().optional(),
  defaultBranch: branchNameSchema.optional(),
  favorite: z.boolean().optional(),
  watchCi: z.boolean().optional(),
  jiraProject: z
    .string()
    .trim()
    .regex(JIRA_PROJECT_PATTERN, "Expected a Jira project key like ABC")
    .nullable()
    .optional(),
  referenceRepoIds: referenceRepoIdsSchema.optional(),
  agentTrust: agentTrustLevelSchema.optional(),
  trustProjectMcp: z.boolean().optional(),
  trustProjectHooks: z.boolean().optional(),
});
export type RepoUpdate = z.infer<typeof repoUpdateSchema>;

/** `POST /api/repos/reorder` body: every repo id in the new order. */
export const reorderReposInputSchema = z.object({
  ids: z
    .array(id)
    .refine((ids) => new Set(ids).size === ids.length, "Each repo can be listed only once"),
});
export type ReorderReposInput = z.infer<typeof reorderReposInputSchema>;

export const DEFAULT_REPO_SCAN_DEPTH = 3;

/** Body for registering every git repo under a root folder. */
export const repoScanInputSchema = z.object({
  root: z.string().trim().min(1),
  /** How many folder levels below `root` to look; 0 checks only `root` itself. */
  maxDepth: z.int().min(0).max(8).default(DEFAULT_REPO_SCAN_DEPTH),
});
export type RepoScanInput = z.input<typeof repoScanInputSchema>;

export const repoScanResultSchema = z.object({
  /** Newly registered repos. */
  added: z.array(repoSchema),
  /** Paths of git repos found that were already registered. */
  skipped: z.array(z.string()),
});
export type RepoScanResult = z.infer<typeof repoScanResultSchema>;

/**
 * Extra permission rules for one agent, in its CLI's own syntax (Claude:
 * `Bash(npm test:*)`, Copilot: `shell(npm test)`, OpenCode: `bash(npm test*)`).
 * Added on top of the stage's permission profile; deny rules always win, so an
 * allow cannot undo a built-in deny.
 */
export const permissionOverridesSchema = z.object({
  allow: z.array(z.string().trim().min(1)).optional(),
  deny: z.array(z.string().trim().min(1)).optional(),
});
export type PermissionOverrides = z.infer<typeof permissionOverridesSchema>;

/** Model id per CLI; a CLI without an entry runs the agent on its own default model. */
export const agentModelsSchema = z.partialRecord(agentCliSchema, z.string().trim().min(1));
export type AgentModels = z.infer<typeof agentModelsSchema>;

/**
 * Reasoning effort levels each CLI accepts, in its own flag's syntax; an empty
 * list means the CLI has no effort setting. Copilot also lists `none` and
 * `minimal`, but Claude models on Copilot reject them, so they are left out.
 */
export const AGENT_EFFORT_LEVELS: Record<AgentCli, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  copilot: ["low", "medium", "high", "xhigh", "max"],
  opencode: [],
};

/**
 * Model ids a CLI refuses an effort for: it exits instead of ignoring the
 * flag. Copilot's `auto` router takes no reasoning effort.
 */
export const AGENT_EFFORT_UNSUPPORTED_MODELS: Partial<Record<AgentCli, RegExp>> = {
  copilot: /^auto$/i,
};

/**
 * Whether an effort may be passed to `cli` for `model` (null for the CLI's
 * default model). False for models in {@link AGENT_EFFORT_UNSUPPORTED_MODELS}.
 */
export function effortFlagApplies(cli: AgentCli, model: string | null | undefined): boolean {
  const unsupported = AGENT_EFFORT_UNSUPPORTED_MODELS[cli];
  return !(model && unsupported?.test(model.trim()));
}

/** Reasoning effort per CLI; a CLI without an entry runs at its own default effort. */
export const agentEffortsSchema = z
  .partialRecord(agentCliSchema, z.string().trim().min(1))
  .superRefine((efforts, ctx) => {
    for (const cli of AGENT_CLIS) {
      const effort = efforts[cli];
      if (effort === undefined) continue;
      const levels = AGENT_EFFORT_LEVELS[cli];
      if (levels.includes(effort)) continue;
      ctx.addIssue({
        code: "custom",
        path: [cli],
        message:
          levels.length === 0
            ? `${cli} has no effort setting`
            : `Invalid ${cli} effort "${effort}". Allowed: ${levels.join(", ")}`,
      });
    }
  });
export type AgentEfforts = z.infer<typeof agentEffortsSchema>;

/** Rejects an effort paired with a model its CLI refuses an effort for. */
function refineModelEfforts(
  agent: { models?: AgentModels | undefined; efforts?: AgentEfforts | undefined },
  ctx: z.RefinementCtx,
): void {
  for (const cli of AGENT_CLIS) {
    const model = agent.models?.[cli];
    if (agent.efforts?.[cli] === undefined || effortFlagApplies(cli, model)) continue;
    ctx.addIssue({
      code: "custom",
      path: ["efforts", cli],
      message: `${cli} model "${model}" takes no effort; leave the effort blank`,
    });
  }
}

/** OpenCode permission keys a rule may name; `bash` also takes a command glob. */
export const OPENCODE_TOOLS = [
  "read",
  "grep",
  "glob",
  "list",
  "edit",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "skill",
  "lsp",
  "external_directory",
  "bash",
] as const;

/**
 * One OpenCode permission rule: a tool key from {@link OPENCODE_TOOLS},
 * `bash(<glob>)` for matching shell commands, or `task(<glob>)` for matching
 * sub-agent names. OpenCode rules become config, not flags, so unlike Claude's
 * and Copilot's they are checked here.
 */
export const opencodeRuleSchema = z.union([
  z.enum(OPENCODE_TOOLS),
  z.string().regex(/^bash\(.+\)$/),
  z.string().regex(/^task\(.+\)$/),
]);

const OPENCODE_RULE_HELP = `OpenCode rules are a tool name (${OPENCODE_TOOLS.join(", ")}) bash(<glob>) or task(<agent>), e.g. bash(npm test*) or task(blackwall-worker)`;

/** Permission overrides per CLI, since each CLI has its own rule syntax. */
export const agentPermissionOverridesSchema = z
  .partialRecord(agentCliSchema, permissionOverridesSchema)
  .superRefine((overrides, ctx) => {
    for (const kind of ["allow", "deny"] as const) {
      overrides.opencode?.[kind]?.forEach((rule, index) => {
        if (!opencodeRuleSchema.safeParse(rule).success) {
          ctx.addIssue({
            code: "custom",
            path: ["opencode", kind, index],
            message: `Invalid OpenCode rule "${rule}". ${OPENCODE_RULE_HELP}`,
          });
        }
      });
    }
  });
export type AgentPermissionOverrides = z.infer<typeof agentPermissionOverridesSchema>;

/**
 * Agent library entry. Agents are not tied to a CLI: a task runs them on its
 * repo's default CLI, or on the CLI chosen for that agent on the task.
 */
export const agentSchema = z.object({
  id,
  name,
  models: agentModelsSchema,
  efforts: agentEffortsSchema,
  /** Role prompt / persona. */
  prompt: z.string(),
  eligibleStages: z.array(stageSchema),
  permissionOverrides: agentPermissionOverridesSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Agent = z.infer<typeof agentSchema>;

export const agentInputSchema = agentSchema
  .pick({ name: true })
  .extend({
    models: agentModelsSchema.default({}),
    efforts: agentEffortsSchema.default({}),
    prompt: agentSchema.shape.prompt.default(""),
    eligibleStages: agentSchema.shape.eligibleStages.default([]),
    permissionOverrides: agentPermissionOverridesSchema.default({}),
  })
  .superRefine(refineModelEfforts);
export type AgentInput = z.input<typeof agentInputSchema>;

/** Body for editing an agent; omitted fields keep their value. */
export const agentUpdateSchema = z
  .object({
    name: agentSchema.shape.name.optional(),
    models: agentModelsSchema.optional(),
    efforts: agentEffortsSchema.optional(),
    prompt: agentSchema.shape.prompt.optional(),
    eligibleStages: agentSchema.shape.eligibleStages.optional(),
    permissionOverrides: agentPermissionOverridesSchema.optional(),
  })
  .superRefine(refineModelEfforts);
export type AgentUpdate = z.infer<typeof agentUpdateSchema>;

/** Pipeline roles an agent can fill; `RoleAgents` holds one entry per role. */
export const AGENT_ROLES = [
  "planner",
  "planReviewers",
  "implementer",
  "codeReviewers",
  "summarizer",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Roles that take several agents (a review panel). */
export const PANEL_ROLES = ["planReviewers", "codeReviewers"] as const satisfies AgentRole[];

/** Stage each role works in; the agent must list it in `eligibleStages`. */
export const ROLE_STAGES: Record<AgentRole, Stage> = {
  planner: "inform",
  planReviewers: "plan-review",
  implementer: "implement",
  codeReviewers: "code-review",
  summarizer: "summarize",
};

/**
 * What an agent may do in its worktree. `read-only`: read, search and safe git
 * (`git diff`, `git log`, `git show`, `git status`). `implement`: also edit files
 * and run shell commands, but never `git push`, `gh` or anything touching a remote.
 */
export const PERMISSION_PROFILES = ["read-only", "implement"] as const;
export const permissionProfileSchema = z.enum(PERMISSION_PROFILES);
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

/** Only the Implement stage edits code; every other stage is read-only. */
export function stagePermissionProfile(stage: Stage): PermissionProfile {
  return stage === "implement" ? "implement" : "read-only";
}

/**
 * Why an agent step runs Locked although its repo is set higher. `review`: a
 * Review PR task reads code someone else wrote. `unchecked-branch`: the PR
 * branch's ownership is not checked yet (or the check failed).
 * `foreign-branch`: the PR, or a commit on its branch, is not the user's.
 */
export const TRUST_FORCED_REASONS = ["review", "unchecked-branch", "foreign-branch"] as const;
export type TrustForcedReason = (typeof TRUST_FORCED_REASONS)[number];

/**
 * The trust an agent step runs under: its level, the Trusted extras, and
 * whether the level was forced below the repo's setting (with why).
 */
export interface AgentTrust {
  level: AgentTrustLevel;
  /** Trusted implement steps start the repo's project MCP servers. */
  projectMcp: boolean;
  /** Trusted implement steps run the repo's project hooks. */
  projectHooks: boolean;
  forced: boolean;
  forcedReason: TrustForcedReason | null;
}

/** Today's sandbox: what every agent ran under before trust levels existed. */
export const LOCKED_TRUST: AgentTrust = {
  level: "locked",
  projectMcp: false,
  projectHooks: false,
  forced: false,
  forcedReason: null,
};

/**
 * CLIs that, under Trusted, also load the user's own global agents, skills and
 * MCP servers, because the CLI has no way to load the repo's config without
 * the user's. Copilot CLI reads `~/.copilot` (its config dir) for both, so
 * isolating it would also hide the user's login. The settings copy and the
 * steps they run warn about it.
 */
export const TRUSTED_LOADS_GLOBAL_CONFIG: readonly AgentCli[] = ["copilot"];

/** Git commands a read-only agent may run: they only read history and the working tree. */
export const SAFE_GIT_COMMANDS = ["git diff", "git log", "git show", "git status"] as const;

/**
 * Commands that reach a remote or change remote configuration, plus the git
 * forms that could hide one (`git -C <dir> push`, `git -c alias.x=push x`, a
 * configured alias). Denied for every profile: the harness alone pushes, after
 * the user confirms.
 */
export const REMOTE_COMMANDS = [
  "git push",
  "git pull",
  "git fetch",
  "git remote",
  "git clone",
  "git ls-remote",
  "git submodule",
  "git config",
  "git -C",
  "git -c",
  "gh",
] as const;

export const tagSchema = z.object({ name, position: z.int().nonnegative() });
export type Tag = z.infer<typeof tagSchema>;

/** A finding tag as reviewers write it: lower-case words joined by hyphens, e.g. `code-quality`. */
export const tagNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    "Tags are lower-case words joined by hyphens, e.g. code-quality",
  )
  .max(40, "Tags are at most 40 characters");

/** Body for replacing the tag list; the order is the display order. */
export const tagListInputSchema = z.object({
  tags: z
    .array(tagNameSchema)
    .refine((tags) => new Set(tags).size === tags.length, "Each tag can be listed only once"),
});
export type TagListInput = z.infer<typeof tagListInputSchema>;

/** Agent ids chosen per pipeline role. */
export const roleAgentsSchema = z.object({
  planner: id.optional(),
  planReviewers: z.array(id).optional(),
  implementer: id.optional(),
  codeReviewers: z.array(id).optional(),
  summarizer: id.optional(),
});
export type RoleAgents = z.infer<typeof roleAgentsSchema>;

/** Per-agent CLI choices on one task, by agent id; agents not listed run on the task's CLI. */
export const agentClisSchema = z.record(id, agentCliSchema);
export type AgentClis = z.infer<typeof agentClisSchema>;

/** The CLI a task runs one of its agents on. */
export function agentCliFor(
  task: { cli: AgentCli; agentClis: AgentClis },
  agentId: string,
): AgentCli {
  return task.agentClis[agentId] ?? task.cli;
}

/** The files a speech model of each kind needs, by the recognizer config field they fill. */
export const VOICE_MODEL_FILES = {
  moonshine: ["preprocessor", "encoder", "uncachedDecoder", "cachedDecoder", "tokens"],
  whisper: ["encoder", "decoder", "tokens"],
} as const;
export type VoiceModelKind = keyof typeof VOICE_MODEL_FILES;

/** A downloadable sherpa-onnx speech model: its release archive and the files in it. */
export type VoiceModelSpec = {
  [K in VoiceModelKind]: {
    label: string;
    /** Release archive name under sherpa-onnx's `asr-models`, and the folder it unpacks to. */
    archive: string;
    kind: K;
    files: Record<(typeof VOICE_MODEL_FILES)[K][number], string>;
    /** Download size, roughly. */
    approxMb: number;
  };
}[VoiceModelKind];

/** The speech models voice control can use, by id. The single place to fix archive file names. */
export const VOICE_MODELS = {
  "moonshine-tiny-en": {
    label: "Moonshine tiny (English)",
    archive: "sherpa-onnx-moonshine-tiny-en-int8",
    kind: "moonshine",
    files: {
      preprocessor: "preprocess.onnx",
      encoder: "encode.int8.onnx",
      uncachedDecoder: "uncached_decode.int8.onnx",
      cachedDecoder: "cached_decode.int8.onnx",
      tokens: "tokens.txt",
    },
    approxMb: 100,
  },
  "whisper-small": {
    label: "Whisper small (multilingual)",
    archive: "sherpa-onnx-whisper-small",
    kind: "whisper",
    files: {
      encoder: "small-encoder.int8.onnx",
      decoder: "small-decoder.int8.onnx",
      tokens: "small-tokens.txt",
    },
    approxMb: 610,
  },
} as const satisfies Record<string, VoiceModelSpec>;
export type VoiceModelId = keyof typeof VOICE_MODELS;
export const VOICE_MODEL_IDS = Object.keys(VOICE_MODELS) as [VoiceModelId, ...VoiceModelId[]];
export const DEFAULT_VOICE_MODEL: VoiceModelId = "moonshine-tiny-en";
export const voiceModelIdSchema = z.enum(VOICE_MODEL_IDS);
/** Where sherpa-onnx publishes the speech model archives: `<releases>/<archive>.tar.bz2`. */
export const VOICE_MODEL_RELEASES =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/** `KeyboardEvent.code`s a hold-to-talk key may use. */
export const VOICE_HOTKEY_CODES: readonly string[] = [
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  "Space",
];

/** A chord that a hold-to-talk key may not be; an omitted flag matches either state. */
export interface ReservedHotkey {
  code: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

const MOD_RESERVED_CODES = [
  // Window, reload, quit and Hide chords of browsers and Electron's default menu.
  "KeyW",
  "KeyT",
  "KeyN",
  "KeyQ",
  "KeyR",
  "KeyM",
  "KeyH",
  // Edit chords: the desktop hook does not swallow keys, so these would act in the foreground app too.
  "KeyA",
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyY",
  // Devtools (with Shift) and reset zoom.
  "KeyI",
  "Digit0",
  // blackwall's own shortcuts: save settings (`settings/parts.tsx`) and search (`search.ts`).
  "KeyS",
  "KeyK",
];

/**
 * Chords a hold-to-talk key may not be: browser chords a page cannot block,
 * Electron's default-menu accelerators and blackwall's own ⌘/Ctrl shortcuts.
 * Add every new app-level ⌘/Ctrl shortcut here.
 */
export const RESERVED_HOTKEYS: readonly ReservedHotkey[] = [
  ...MOD_RESERVED_CODES.flatMap((code) => [
    { code, ctrl: true, alt: false, meta: false },
    { code, meta: true, alt: false, ctrl: false },
  ]),
  // macOS devtools and Hide Others.
  { code: "KeyI", alt: true, meta: true, ctrl: false },
  { code: "KeyH", alt: true, meta: true, ctrl: false },
  // Browser fullscreen and devtools.
  { code: "F11", ctrl: false, alt: false, shift: false, meta: false },
  { code: "F12", ctrl: false, alt: false, shift: false, meta: false },
  // Closes the window on Windows.
  { code: "F4", alt: true, ctrl: false, meta: false },
];

export const voiceHotkeyObjectSchema = z.object({
  code: z.enum(VOICE_HOTKEY_CODES),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
});

/** True when `hotkey` is one of {@link RESERVED_HOTKEYS}. */
export function isReservedHotkey(hotkey: z.infer<typeof voiceHotkeyObjectSchema>): boolean {
  return RESERVED_HOTKEYS.some(
    (reserved) =>
      reserved.code === hotkey.code &&
      (reserved.ctrl === undefined || reserved.ctrl === hotkey.ctrl) &&
      (reserved.alt === undefined || reserved.alt === hotkey.alt) &&
      (reserved.shift === undefined || reserved.shift === hotkey.shift) &&
      (reserved.meta === undefined || reserved.meta === hotkey.meta),
  );
}

/**
 * The key held for push-to-talk. Letters, digits and Space need Ctrl, Alt or
 * Meta (Shift alone is normal typing); F-keys may go bare.
 */
export const voiceHotkeySchema = voiceHotkeyObjectSchema
  .refine((hotkey) => /^F\d+$/.test(hotkey.code) || hotkey.ctrl || hotkey.alt || hotkey.meta, {
    message: "Add Ctrl, Alt or ⌘ to letters, digits and Space",
  })
  .refine((hotkey) => !isReservedHotkey(hotkey), {
    message: "That key is reserved by the browser or the app",
  });
export type VoiceHotkey = z.infer<typeof voiceHotkeySchema>;

/** A hold-to-talk key for display, e.g. "Ctrl Alt Space", or "⌥⌘Space" on macOS. */
export function voiceHotkeyLabel(hotkey: VoiceHotkey, mac: boolean): string {
  const key = hotkey.code.replace(/^Key|^Digit/, "");
  if (mac) {
    return `${hotkey.ctrl ? "⌃" : ""}${hotkey.alt ? "⌥" : ""}${hotkey.shift ? "⇧" : ""}${hotkey.meta ? "⌘" : ""}${key}`;
  }
  return [
    hotkey.ctrl && "Ctrl",
    hotkey.alt && "Alt",
    hotkey.shift && "Shift",
    hotkey.meta && "Meta",
    key,
  ]
    .filter(Boolean)
    .join(" ");
}

export const DEFAULT_MAX_TASKS_PER_REPO = 3;
export const DEFAULT_MAX_BACKLOG_TASKS_PER_REPO = 1;
export const DEFAULT_GITHUB_ISSUES_REFRESH_SECONDS = 60;
export const MIN_GITHUB_ISSUES_REFRESH_SECONDS = 15;
export const MAX_GITHUB_ISSUES_REFRESH_SECONDS = 3600;

export const settingsSchema = z.object({
  roleDefaults: roleAgentsSchema.default({}),
  maxTasksPerRepo: z.int().min(1).max(20).default(DEFAULT_MAX_TASKS_PER_REPO),
  /** Whether the backlog runner promotes backlog items on its own (per repo switch on top). */
  backlogRunner: z.boolean().default(true),
  /** How many backlog-originated tasks may run at once in a repo without its own cap. */
  maxBacklogTasksPerRepo: backlogCapSchema.default(DEFAULT_MAX_BACKLOG_TASKS_PER_REPO),
  /** Hold a repo's backlog while one of its backlog tasks waits on the user. */
  stopBacklogOnNeedsYou: z.boolean().default(true),
  /** How often GitHub issue lists re-read GitHub, in seconds. */
  githubIssuesRefreshSeconds: z
    .int()
    .min(MIN_GITHUB_ISSUES_REFRESH_SECONDS)
    .max(MAX_GITHUB_ISSUES_REFRESH_SECONDS)
    .default(DEFAULT_GITHUB_ISSUES_REFRESH_SECONDS),
  /** The speech model voice control transcribes with. */
  voiceModel: voiceModelIdSchema.default(DEFAULT_VOICE_MODEL),
  /** The key held for push-to-talk; null when off. */
  voiceHotkey: voiceHotkeySchema.nullable().default(null),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

/** Settings other than the role defaults (which live under `/api/agents/role-defaults`). */
export const generalSettingsSchema = settingsSchema.omit({ roleDefaults: true });
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

/** How many backlog tasks may run at once in a repo: its own cap, else the global one. */
export function backlogCapFor(
  repo: Pick<Repo, "maxBacklogTasks"> | undefined,
  general: Pick<GeneralSettings, "maxBacklogTasksPerRepo">,
): number {
  return repo?.maxBacklogTasks ?? general.maxBacklogTasksPerRepo;
}

/** Body for editing the general settings; omitted fields keep their value. */
export const generalSettingsUpdateSchema = z.object({
  maxTasksPerRepo: settingsSchema.shape.maxTasksPerRepo.unwrap().optional(),
  backlogRunner: z.boolean().optional(),
  maxBacklogTasksPerRepo: settingsSchema.shape.maxBacklogTasksPerRepo.unwrap().optional(),
  stopBacklogOnNeedsYou: z.boolean().optional(),
  githubIssuesRefreshSeconds: settingsSchema.shape.githubIssuesRefreshSeconds.unwrap().optional(),
  voiceModel: voiceModelIdSchema.optional(),
  voiceHotkey: voiceHotkeySchema.nullable().optional(),
});
export type GeneralSettingsUpdate = z.infer<typeof generalSettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const jiraIssueOriginSchema = z.object({
  kind: z.literal("jira-issue"),
  key: z.string().regex(JIRA_KEY_PATTERN, "Expected a Jira key like ABC-123"),
  connectionId: id.nullable(),
});

export const pullRequestStackSchema = z.object({
  prs: z.array(z.int().positive()).min(2),
});
export type PullRequestStack = z.infer<typeof pullRequestStackSchema>;

export const githubPrOriginSchema = z.object({
  kind: z.literal("github-pr"),
  url: z.url(),
  owner: name,
  repo: name,
  number: z.int().positive(),
  connectionId: id.nullable(),
  /**
   * PRs of the stack this PR belonged to when it was added, bottom first; the
   * first is the stack's id. Set by the server only; client-sent values are dropped.
   */
  stack: pullRequestStackSchema.optional(),
});

/** A GitHub/GHE issue: worked on a new branch like a Jira issue, delivered as a PR that closes it. */
export const githubIssueOriginSchema = z.object({
  kind: z.literal("github-issue"),
  url: z.url(),
  owner: name,
  repo: name,
  number: z.int().positive(),
  connectionId: id.nullable(),
});

export const freeTextOriginSchema = z.object({ kind: z.literal("free-text") });

export const taskOriginSchema = z.discriminatedUnion("kind", [
  jiraIssueOriginSchema,
  githubPrOriginSchema,
  githubIssueOriginSchema,
  freeTextOriginSchema,
]);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

/** A Jira or GitHub origin's short reference: the Jira key, or `owner/repo#number`. */
export function originRef(origin: Exclude<TaskOrigin, { kind: "free-text" }>): string {
  return origin.kind === "jira-issue"
    ? origin.key
    : `${origin.owner}/${origin.repo}#${origin.number}`;
}

/** A registry repo plus the task's own worktree and branch (set once created). */
export const workspaceSchema = z.object({
  repoId: id,
  branch: z.string().nullable(),
  /**
   * PR tasks: the pull request's base branch when the worktree was created,
   * where its diffs fork from. Null for other tasks and older PR tasks.
   */
  baseBranch: z.string().nullable(),
  worktreePath: z.string().nullable(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** PR tasks need a mode; other origins must not have one. */
function checkMode(
  value: { origin: TaskOrigin; mode: PrMode | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const isPr = value.origin.kind === "github-pr";
  if (isPr && value.mode == null) {
    ctx.addIssue({ code: "custom", path: ["mode"], message: "PR tasks need a mode" });
  } else if (!isPr && value.mode != null) {
    ctx.addIssue({ code: "custom", path: ["mode"], message: "Only PR tasks have a mode" });
  }
}

export const taskSchema = z
  .object({
    id,
    title: name,
    origin: taskOriginSchema,
    /** PR tasks only. */
    mode: prModeSchema.nullable(),
    /** PR tasks only: whether the branch holds only the user's commits; null for other tasks. */
    prBranch: prBranchSchema.nullable(),
    ...workspaceSchema.shape,
    status: taskStatusSchema,
    /** Current pipeline stage; null before the first step starts. */
    stage: stageSchema.nullable(),
    /** What the task waits on while `needs-you`; null otherwise. */
    gate: gateSchema.nullable(),
    /**
     * Why the task failed, or why an `interrupted` one stopped (a usage limit,
     * or {@link TASK_STOPPED_ERROR}); null otherwise.
     */
    error: z.string().nullable(),
    triageMode: triageModeSchema,
    agents: roleAgentsSchema,
    /** CLI the agents run on: the repo's default CLI when the task was created. */
    cli: agentCliSchema,
    /** Agents run on another CLI than `cli`, chosen on the new task form. */
    agentClis: agentClisSchema,
    /**
     * Repos the read-only agents may read: the repo's reference repos when the
     * task was created, or the form's choice.
     */
    referenceRepoIds: z.array(id),
    deliveryTargets: z.array(deliveryTargetSchema),
    /** True while the confirmed delivery actions run at finish (or a Review PR's review posts); the task stays `needs-you` at its gate meanwhile. */
    delivering: z.boolean(),
    freeText: z.string(),
    plan: z.string().nullable(),
    /** The summarizer's final summary (changes, decisions, leftover findings); null until Summarize. */
    summary: z.string().nullable(),
    /** Brief, outward summary of the behavioural/visual change; the body of PRs and comments at finish. Null until Summarize. */
    shortSummary: z.string().nullable(),
    /** Commit message for the optional squash at finish, written with the summary. */
    squashMessage: z.string().nullable(),
    /** Follow-up tasks the summarizer proposed; offered at finish as `create-tasks`. */
    followUps: z.array(followUpSchema),
    /** Set when the user archives a done task; hidden from the Inbox and the backlog view's lists. */
    archivedAt: timestamp.nullable(),
    /** CI on the commit the task last pushed to a GitHub/GHE remote; null when not watched. */
    ci: taskCiSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine(checkMode);
export type Task = z.infer<typeof taskSchema>;

/**
 * The trust a task's agents run under. A Locked repo runs Locked. Otherwise
 * any task that runs code the user didn't write is forced Locked: a Review PR
 * task (`review`), and a work PR task whose branch is not known to hold only
 * the user's commits (`unchecked-branch` until checked, `foreign-branch` when
 * it doesn't; a PR task with no state recorded counts as unchecked). Every
 * other task runs at the repo's level. `forced` means
 * "lower than the repo's setting", so a Locked repo is never forced.
 */
export function effectiveTrust(
  repo: Pick<Repo, "agentTrust" | "trustProjectMcp" | "trustProjectHooks">,
  task: Pick<Task, "origin" | "mode" | "prBranch">,
): AgentTrust {
  if (repo.agentTrust === "locked") return LOCKED_TRUST;
  const isPr = task.origin.kind === "github-pr";
  const forcedReason: TrustForcedReason | null =
    task.mode === "review"
      ? "review"
      : task.prBranch === "foreign"
        ? "foreign-branch"
        : // A PR task without a recorded check fails closed too.
          task.prBranch === "unchecked" || (isPr && task.prBranch !== "owned")
          ? "unchecked-branch"
          : null;
  if (forcedReason) return { ...LOCKED_TRUST, forced: true, forcedReason };
  return {
    level: repo.agentTrust,
    projectMcp: repo.agentTrust === "trusted" && repo.trustProjectMcp,
    projectHooks: repo.agentTrust === "trusted" && repo.trustProjectHooks,
    forced: false,
    forcedReason: null,
  };
}

/**
 * Whether a done task's CI failed and it is still listed: it shows under
 * Needs you with a Fix CI action until it is archived.
 */
export function ciNeedsYou(task: Pick<Task, "status" | "archivedAt" | "ci">): boolean {
  return task.status === "done" && !task.archivedAt && task.ci?.state === "failed";
}

/** A comment the user wrote (or kept) for a GitHub issue task's issue. */
export const issueCommentInputSchema = z.object({ body: z.string().trim().min(1) });
export type IssueCommentInput = z.infer<typeof issueCommentInputSchema>;

/** Only GitHub issue tasks comment on their issue when work starts. */
function checkStartComment(
  value: { origin: TaskOrigin; startComment?: IssueCommentInput | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.startComment && value.origin.kind !== "github-issue") {
    ctx.addIssue({
      code: "custom",
      path: ["startComment"],
      message: "Only GitHub issue tasks comment when work starts",
    });
  }
}

/** Only GitHub issue tasks assign their issue to the user. */
function checkAssignToMe(
  value: { origin: TaskOrigin; assignToMe?: boolean | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.assignToMe && value.origin.kind !== "github-issue") {
    ctx.addIssue({
      code: "custom",
      path: ["assignToMe"],
      message: "Only GitHub issue tasks can be assigned",
    });
  }
}

/** New task form / `POST /api/tasks` body. */
export const newTaskInputSchema = z
  .object({
    origin: taskOriginSchema,
    mode: prModeSchema.nullable().default(null),
    repoId: id,
    /** Derived from the origin when omitted. */
    title: name.optional(),
    freeText: z.string().default(""),
    agents: roleAgentsSchema.default({}),
    /** Agents to run on another CLI than the repo's default. */
    agentClis: agentClisSchema.default({}),
    /** Reference repos for the task; null uses the repo's. */
    referenceRepoIds: referenceRepoIdsSchema.nullable().default(null),
    triageMode: triageModeSchema.default("intervene"),
    /**
     * GitHub issue tasks only: a comment the user confirmed, posted on the
     * issue when the task is created. Omitted: nothing is posted.
     */
    startComment: issueCommentInputSchema.optional(),
    /** GitHub issue tasks only: assign the issue to the token's user when the task is created. */
    assignToMe: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    checkMode(value, ctx);
    if (value.origin.kind === "free-text" && value.freeText.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["freeText"], message: "Describe the task" });
    }
    checkStartComment(value, ctx);
    checkAssignToMe(value, ctx);
  });
export type NewTaskInput = z.input<typeof newTaskInputSchema>;

// ---------------------------------------------------------------------------
// Backlog
// ---------------------------------------------------------------------------

const backlogTitle = name.max(MAX_TITLE_CHARS);
const backlogDependsOn = z
  .array(id)
  .refine((ids) => new Set(ids).size === ids.length, "Each dependency can be listed only once");

/** Blackwall items need a description, like Blackwall tasks. */
function checkBacklogText(
  value: { origin: TaskOrigin; freeText: string },
  ctx: z.RefinementCtx,
): void {
  if (value.origin.kind === "free-text" && value.freeText.trim() === "") {
    ctx.addIssue({ code: "custom", path: ["freeText"], message: "Describe the task" });
  }
}

/**
 * Work parked in a repo's backlog. It is not a task until promoted, by the
 * user or the backlog runner; promotion creates a normal queued task.
 */
export const backlogItemSchema = z
  .object({
    id,
    repoId: id,
    title: backlogTitle,
    origin: taskOriginSchema,
    /** PR origins only. */
    mode: prModeSchema.nullable(),
    freeText: z.string(),
    agents: roleAgentsSchema,
    /** Agents to run on another CLI than the repo's default once promoted. */
    agentClis: agentClisSchema,
    /** Reference repos for the task once promoted; null follows the repo's until then. */
    referenceRepoIds: z.array(id).nullable(),
    triageMode: triageModeSchema,
    /** Manual order in the repo's backlog. */
    position: z.int(),
    /** Backlog items (same repo) that must be done first. */
    dependsOn: z.array(id),
    status: backlogStatusSchema,
    /** The task it was promoted to; null until promoted (or once that task is deleted). */
    taskId: id.nullable(),
    /** The task that proposed it as a follow-up; null otherwise (or once that task is deleted). */
    sourceTaskId: id.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine(checkMode);
export type BacklogItem = z.infer<typeof backlogItemSchema>;

/** A backlog item as listed: in pick order, with the dependencies holding it back. */
export const backlogItemViewSchema = z.intersection(
  backlogItemSchema,
  z.object({
    blocked: z.boolean(),
    /** Unmet dependency ids, including ones that no longer exist. */
    blockedBy: z.array(id),
  }),
);
export type BacklogItemView = z.infer<typeof backlogItemViewSchema>;

/**
 * `POST /api/repos/:repoId/backlog` body. Backlog items run unattended, hence `intervene`.
 * Without a title the server uses the Jira summary, PR or issue title, or a fallback. With
 * `start` the item is promoted at once when the repo's backlog runner is on and
 * its dependencies are done.
 */
export const newBacklogItemInputSchema = z
  .object({
    origin: taskOriginSchema,
    mode: prModeSchema.nullable().default(null),
    title: backlogTitle.optional(),
    freeText: z.string().default(""),
    agents: roleAgentsSchema.default({}),
    agentClis: agentClisSchema.default({}),
    /** Null follows the repo's reference repos until the item is promoted. */
    referenceRepoIds: referenceRepoIdsSchema.nullable().default(null),
    triageMode: triageModeSchema.default("intervene"),
    dependsOn: backlogDependsOn.default([]),
    /** Not stored: whether to promote the item at once when the runner would. */
    start: z.boolean().default(false),
    /**
     * Not stored, GitHub issue items only: a comment the user confirmed,
     * posted on the issue only when the item is promoted at once (`start`).
     */
    startComment: issueCommentInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    checkMode(value, ctx);
    checkBacklogText(value, ctx);
    checkStartComment(value, ctx);
  });
export type NewBacklogItemInput = z.input<typeof newBacklogItemInputSchema>;

/** `PATCH /api/repos/:repoId/backlog/:id` body; omitted fields keep their value. */
export const updateBacklogItemInputSchema = z.object({
  title: backlogTitle.optional(),
  freeText: z.string().optional(),
  dependsOn: backlogDependsOn.optional(),
  /** Hold an item back or release it; promotion happens through `run`. */
  status: z.enum(["waiting", "paused"]).optional(),
  agents: roleAgentsSchema.optional(),
  agentClis: agentClisSchema.optional(),
  referenceRepoIds: referenceRepoIdsSchema.nullable().optional(),
  triageMode: triageModeSchema.optional(),
});
export type UpdateBacklogItemInput = z.infer<typeof updateBacklogItemInputSchema>;

/** `POST /api/repos/:repoId/backlog/reorder` body: the repo's item ids in their new order. */
export const reorderBacklogInputSchema = z.object({
  ids: z
    .array(id)
    .refine((ids) => new Set(ids).size === ids.length, "Each item can be listed only once"),
});
export type ReorderBacklogInput = z.infer<typeof reorderBacklogInputSchema>;

/**
 * A repo's backlog runner: switched on or off for the repo, and halted when
 * one of its backlog tasks failed (the user resumes it).
 */
export const repoBacklogRunnerSchema = z.object({
  enabled: z.boolean().default(true),
  /** The failed backlog task that halted the runner; null when not halted. */
  haltedTaskId: id.nullable().default(null),
  haltedAt: timestamp.nullable().default(null),
  /**
   * Agents make every decision for the repo's backlog tasks: they answer
   * their own questions, approve plans and triage, and finish by merging
   * into the local default branch and creating follow-ups. Local only: it
   * never pushes, opens PRs or posts anywhere. Off by default.
   */
  autonomous: z.boolean().default(false),
  /**
   * When the repo's queue has nothing left to start, the runner imports the
   * open GitHub issues of the repo's `origin` as backlog items, one at a
   * time. It never assigns or comments on them. Off by default.
   */
  includeRemoteIssues: z.boolean().default(false),
});
export type RepoBacklogRunner = z.infer<typeof repoBacklogRunnerSchema>;

/** `PATCH /api/repos/:repoId/backlog/runner` body: at least one field. */
export const repoBacklogRunnerUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    includeRemoteIssues: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.enabled !== undefined ||
      input.autonomous !== undefined ||
      input.includeRemoteIssues !== undefined,
    "Set enabled, autonomous or includeRemoteIssues",
  );
export type RepoBacklogRunnerUpdate = z.infer<typeof repoBacklogRunnerUpdateSchema>;

/** An agent CLI's usage limit: paused until its quota resets, or null when usable. */
export const quotaStateSchema = z.object({
  cli: agentCliSchema,
  pausedUntil: timestamp.nullable(),
});
export type QuotaState = z.infer<typeof quotaStateSchema>;

/** Body for looking up a pasted pull request link on the new task form. */
export const pullRequestLookupInputSchema = z.object({ url: z.string().trim().min(1) });
export type PullRequestLookupInput = z.infer<typeof pullRequestLookupInputSchema>;

/** A pull request link resolved against the GitHub connections and the repo registry. */
export const pullRequestLookupSchema = z.object({
  /** The task origin for the PR; `connectionId` is null when no connection exists for its host. */
  origin: githubPrOriginSchema,
  /** The registered repo whose `origin` remote is the PR's repo; null: ask the user to register it. */
  repoId: id.nullable(),
});
export type PullRequestLookup = z.infer<typeof pullRequestLookupSchema>;

/** Body for looking up a pasted GitHub issue link on the new task form. */
export const issueLookupInputSchema = z.object({ url: z.string().trim().min(1) });
export type IssueLookupInput = z.infer<typeof issueLookupInputSchema>;

/** A GitHub issue link resolved against the GitHub connections and the repo registry. */
export const issueLookupSchema = z.object({
  /** The task origin for the issue; `connectionId` is null when no connection exists for its host. */
  origin: githubIssueOriginSchema,
  /** The registered repo whose `origin` remote is the issue's repo; null: the user picks one. */
  repoId: id.nullable(),
});
export type IssueLookup = z.infer<typeof issueLookupSchema>;

/**
 * An open pull request waiting on the user's review on one GitHub/GHE host:
 * review requested from the user or one of their teams, not a draft and not
 * approved by anyone.
 */
export const reviewRequestSchema = z.object({
  /** Host of the connection it came from (`github.com`, `acme.ghe.com`). */
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.int(),
  title: z.string(),
  url: z.url(),
  /** Author's login; null for a deleted account. */
  author: z.string().nullable(),
  updatedAt: timestamp,
  /** GitHub's review decision; null when the repo requires no reviews. */
  reviewDecision: z.enum(["review-required", "changes-requested"]).nullable(),
  /** The registered repo whose `origin` remote is the PR's repository; null: not registered. */
  repoId: id.nullable(),
  /** The connection for the PR's host; null when none matches. */
  connectionId: id.nullable(),
});
export type ReviewRequest = z.infer<typeof reviewRequestSchema>;

/** `GET /api/pull-requests/review-requests`: every host's rows, newest first, and the hosts that failed. */
export const reviewRequestsSchema = z.object({
  pullRequests: reviewRequestSchema.array(),
  errors: z.object({ host: z.string(), message: z.string() }).array(),
});
export type ReviewRequests = z.infer<typeof reviewRequestsSchema>;

/** An open issue assigned to the user on one GitHub/GHE host. */
export const assignedIssueSchema = z.object({
  /** Host of the connection it came from (`github.com`, `acme.ghe.com`). */
  host: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.int(),
  title: z.string(),
  url: z.url(),
  /** Author's login; null for a deleted account. */
  author: z.string().nullable(),
  updatedAt: timestamp,
  /** The registered repo whose `origin` remote is the issue's repository; null: not registered. */
  repoId: id.nullable(),
  /** The connection for the issue's host; null when none matches. */
  connectionId: id.nullable(),
});
export type AssignedIssue = z.infer<typeof assignedIssueSchema>;

/** `GET /api/issues/assigned`: every host's rows, newest first, and the hosts that failed. */
export const assignedIssuesSchema = z.object({
  issues: assignedIssueSchema.array(),
  errors: z.object({ host: z.string(), message: z.string() }).array(),
});
export type AssignedIssues = z.infer<typeof assignedIssuesSchema>;

/** An open issue in a repo's GitHub/GHE repository, whoever it is assigned to. */
export const repoIssueSchema = assignedIssueSchema.extend({
  /** Logins of the issue's assignees; empty when unassigned. */
  assignees: z.string().array(),
});
export type RepoIssue = z.infer<typeof repoIssueSchema>;

/**
 * `GET /api/issues/repo/:repoId`: the repo's open issues, at most the 100 most
 * recently updated, newest first, and the host when it failed.
 */
export const repoIssuesSchema = z.object({
  issues: repoIssueSchema.array(),
  errors: z.object({ host: z.string(), message: z.string() }).array(),
});
export type RepoIssues = z.infer<typeof repoIssuesSchema>;

/** An open issue in a repo's Jira project, unassigned or assigned to the user. */
export const repoJiraIssueSchema = z.object({
  /** Host of the Jira site it came from (`acme.atlassian.net`). */
  host: z.string(),
  key: z.string().regex(JIRA_KEY_PATTERN),
  title: z.string(),
  /** The issue's `/browse/<key>` link. */
  url: z.url(),
  /** Issue type name (`Bug`, `Story`); null when Jira sends none. */
  issueType: z.string().nullable(),
  /** Status name; null when Jira sends none. */
  status: z.string().nullable(),
  /** Reporter's display name; null when unknown. */
  author: z.string().nullable(),
  /** Assignee's display name; null when unassigned. */
  assignee: z.string().nullable(),
  updatedAt: timestamp,
  repoId: id,
  /** The Jira connection the issue was listed through. */
  connectionId: id,
});
export type RepoJiraIssue = z.infer<typeof repoJiraIssueSchema>;

/**
 * `GET /api/issues/jira/:repoId`: the open issues of the repo's Jira project,
 * unassigned or assigned to the user, at most the 100 most recently updated,
 * newest first, and the site when it failed.
 */
export const repoJiraIssuesSchema = z.object({
  issues: repoJiraIssueSchema.array(),
  errors: z.object({ host: z.string(), message: z.string() }).array(),
});
export type RepoJiraIssues = z.infer<typeof repoJiraIssuesSchema>;

/**
 * One round's changes on the task branch: the range Code review reviewed in
 * that round, or (`reviewed: false`) commits made since the last review.
 */
export const taskDiffSchema = z.object({
  /** Fix round: 0 for the first implementation. */
  round: z.int().nonnegative(),
  from: z.string(),
  to: z.string(),
  reviewed: z.boolean(),
  /** Unified diff (`git diff from to`). */
  diff: z.string(),
});
export type TaskDiff = z.infer<typeof taskDiffSchema>;

/** The task branch's whole diff, from its fork point to HEAD; the step-through comments on it. */
export const branchDiffSchema = taskDiffSchema.pick({ from: true, to: true, diff: true });
export type BranchDiff = z.infer<typeof branchDiffSchema>;

/**
 * An inline review thread already on a task's GitHub pull request: where the
 * root comment sits on the PR's current head, and every reply, oldest first.
 */
export const pullRequestThreadSchema = z.object({
  /** The root comment's id. */
  id: z.int(),
  path: z.string(),
  /** Line on the PR's current head; null once GitHub marks the thread outdated. */
  line: z.int().nullable(),
  /** First line of a multi-line comment. */
  startLine: z.int().nullable(),
  /** `LEFT` for the old side of the diff (deleted lines), `RIGHT` for the new. */
  side: z.enum(["LEFT", "RIGHT"]),
  outdated: z.boolean(),
  url: z.string().nullable(),
  comments: z
    .object({
      id: z.int(),
      author: z.string(),
      body: z.string(),
      createdAt: timestamp.nullable(),
    })
    .array(),
});
export type PullRequestThread = z.infer<typeof pullRequestThreadSchema>;

/**
 * `GET /api/tasks/:id/pr-comments`: the PR's inline review threads, or why
 * they couldn't be read (reported, not thrown, so polling stays quiet).
 */
export const pullRequestCommentsSchema = z.object({
  threads: pullRequestThreadSchema.array(),
  error: z.string().nullable(),
});
export type PullRequestComments = z.infer<typeof pullRequestCommentsSchema>;

/**
 * `POST /api/tasks/:id/pr/refresh`: the head a Review PR task last reviewed,
 * the PR head branch's sha on the remote now, and whether it moved since.
 */
export const pullRequestRefreshSchema = z.object({
  reviewedSha: z.string(),
  headSha: z.string(),
  changed: z.boolean(),
});
export type PullRequestRefresh = z.infer<typeof pullRequestRefreshSchema>;

/** Scratch folder in a task's worktree; ignored by its own `.gitignore`. */
export const SCRATCH_DIR = ".blackwall";

/**
 * Largest image or text artifact served inline; bigger ones are listed but
 * can't be opened. Other files stream as downloads with no cap.
 */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

/**
 * How an artifact is served, by extension: `image` inline as a raster image,
 * `text` inline as `text/plain`, and `file` as a download.
 */
export const artifactKindSchema = z.enum(["image", "text", "file"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** A file an implementer saved to `.blackwall/artifacts/` in the task's worktree. */
export const taskArtifactSchema = z.object({
  /** Relative to the artifacts folder, `/`-separated. */
  path: z.string(),
  size: z.int().nonnegative(),
  modifiedAt: timestamp,
  kind: artifactKindSchema,
});
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

/** `GET /api/tasks/:id/worktree`: where the task's worktree is and whether it exists. */
export const taskWorktreeSchema = z.object({
  /** Null before the worktree is created. */
  path: z.string().nullable(),
  exists: z.boolean(),
});
export type TaskWorktree = z.infer<typeof taskWorktreeSchema>;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * One delivery action as offered at finish, with exactly where it goes and
 * what it sends, so the user confirms the real target rather than a label.
 */
export const deliveryActionSchema = z.discriminatedUnion("kind", [
  /** Push the task branch to `remote` under the same name. Never main. */
  z.object({
    kind: z.literal("push-branch"),
    branch: z.string(),
    remote: z.string(),
    /** Local branch renamed to `branch` before the push (free-text tasks opening a PR). */
    from: z.string().optional(),
  }),
  /** Open a pull request on GitHub/GHE from `head` into `base`. */
  z.object({
    kind: z.literal("open-pr"),
    host: z.string(),
    owner: z.string(),
    repo: z.string(),
    head: z.string(),
    base: z.string(),
    title: z.string(),
    body: z.string(),
  }),
  /** Post `body` as a conversation comment on the pull request at `url`. */
  z.object({ kind: z.literal("pr-comment"), url: z.string(), body: z.string() }),
  /** Post `body` as a comment on Jira issue `key` (`url` when the site is known). No transitions. */
  z.object({
    kind: z.literal("jira-comment"),
    key: z.string(),
    url: z.string().nullable(),
    body: z.string(),
  }),
  /** Post `body` as a comment on the GitHub issue at `url`. */
  z.object({ kind: z.literal("issue-comment"), url: z.string(), body: z.string() }),
  /** Rebase `branch` onto local `into`, then fast-forward `into` to it. Local only. */
  z.object({ kind: z.literal("merge-main"), branch: z.string(), into: z.string() }),
  /**
   * Submit a review on the pull request at `url` with the selected findings as
   * inline comments. The user can submit it as an approval instead.
   */
  z.object({
    kind: z.literal("pr-review"),
    url: z.string(),
    /** The findings offered for posting; the user picks which ones go. */
    findingIds: z.array(id),
  }),
  /**
   * Create the selected follow-up tasks as waiting free-text backlog items in
   * each item's repo. Local only; the user picks which ones are created.
   */
  z.object({
    kind: z.literal("create-tasks"),
    items: z.array(
      z.object({ title: z.string(), description: z.string(), repoId: id, repoName: z.string() }),
    ),
  }),
]);
export type DeliveryAction = z.infer<typeof deliveryActionSchema>;

/** The optional squash of the task's commits at finish, before anything is pushed or merged. */
export const deliverySquashSchema = z.object({
  /** Commits that would be squashed into one. */
  commits: z.int().positive(),
  /** Base the commits are counted from (the fork point, or the PR head on the remote). */
  base: z.string(),
  message: z.string(),
});
export type DeliverySquash = z.infer<typeof deliverySquashSchema>;

/**
 * What finishing the task would do. Every action starts ticked in the UI and
 * the squash unticked; only what the user confirms is performed.
 */
export const deliveryPlanSchema = z.object({
  actions: z.array(deliveryActionSchema),
  /** Null when there is nothing to squash (fewer than two commits, or a Review PR task). */
  squash: deliverySquashSchema.nullable(),
  /** Actions already performed for this run; a retry after a failure skips them. */
  completed: z.array(deliveryTargetSchema),
});
export type DeliveryPlan = z.infer<typeof deliveryPlanSchema>;

/**
 * The delivery actions the user confirmed at finish (or, for a Review PR
 * task, at triage). Anything not listed is not performed.
 */
export const deliveryConfirmationSchema = z.object({
  actions: z
    .array(deliveryTargetSchema)
    .refine((a) => new Set(a).size === a.length, "Each action can be confirmed only once")
    .default([]),
  /** Squash the task's commits into one first. */
  squash: z.boolean().default(false),
  /** Review PR tasks: the findings to post as inline review comments. */
  findingIds: z.array(id).default([]),
  /** Indexes into the `create-tasks` items (the task's follow-ups) to create. */
  followUpIndexes: z
    .array(z.int().nonnegative())
    .refine((a) => new Set(a).size === a.length, "Each follow-up can be picked only once")
    .default([]),
  /**
   * Review PR tasks: submit the review as an approval instead of a comment.
   * Only with the `pr-review` action.
   */
  approve: z.boolean().default(false),
});
export type DeliveryConfirmation = z.infer<typeof deliveryConfirmationSchema>;
export type DeliveryConfirmationInput = z.input<typeof deliveryConfirmationSchema>;

/** Body for answering the gate a `needs-you` task waits on. */
export const gateResponseInputSchema = z.object({
  /** The gate being answered; must match the task's current gate. */
  gate: gateSchema,
  decision: gateDecisionSchema,
  /** Instructions passed to the next stage, e.g. the requested plan changes. */
  message: z.string().trim().min(1).optional(),
  /**
   * The confirmed delivery actions when approving the finish gate (or a
   * Review PR task's triage). Omitted: nothing leaves the machine.
   */
  delivery: deliveryConfirmationSchema.optional(),
  /**
   * Only when approving the plan of a GitHub issue task: a comment the user
   * confirmed, posted on the issue before the task moves on. Omitted: nothing
   * is posted.
   */
  issueComment: issueCommentInputSchema.optional(),
});
export type GateResponseInput = z.input<typeof gateResponseInputSchema>;

/**
 * `POST /api/tasks/:id/resume` body (optional). `message`: guidance for the
 * agent steps that failed or stopped; refused for a task stopped at a gate.
 */
export const taskResumeInputSchema = z.object({ message: z.string().trim().min(1).optional() });
export type TaskResumeInput = z.infer<typeof taskResumeInputSchema>;

// ---------------------------------------------------------------------------
// Runs, steps and events
// ---------------------------------------------------------------------------

/** One pass of the pipeline for a task. */
export const runSchema = z.object({
  id,
  taskId: id,
  /** 1-based run number within the task. */
  number: z.int().positive(),
  status: stepStatusSchema,
  createdAt: timestamp,
  finishedAt: timestamp.nullable(),
});
export type Run = z.infer<typeof runSchema>;

/**
 * Tokens an agent step used and what it cost, sub-agents included, summed over
 * all its attempts. `costUsd` is null when its CLI reported no cost (Copilot).
 */
export const usageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

/** One agent (or harness) invocation within a run. */
export const stepSchema = z.object({
  id,
  runId: id,
  stage: stageSchema,
  /** Null for harness-run steps such as checks, or when the agent was deleted. */
  agentId: id.nullable(),
  /** CLI the agent ran on; null for harness-run steps. */
  cli: agentCliSchema.nullable(),
  /** Trust level the agent last ran under; null for harness-run steps and older steps. */
  trust: agentTrustLevelSchema.nullable(),
  /** Whether that level was forced below the repo's setting (see {@link effectiveTrust}). */
  trustForced: z.boolean(),
  /**
   * Reasoning effort passed to the CLI when the step last ran; null for the
   * CLI default, harness steps and older steps.
   */
  effort: z.string().nullable(),
  /** Fix round within the stage loop (0 for the first pass). */
  round: z.int().nonnegative(),
  /**
   * Which visit of its stage within the run (0 for the first). A stage is
   * visited again after a gate sends work back or a loop comes round; resuming
   * continues the steps of the latest visit.
   */
  visit: z.int().nonnegative(),
  status: stepStatusSchema,
  /** CLI session id, used for `--resume`. */
  sessionId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  ...usageSchema.shape,
});
export type Step = z.infer<typeof stepSchema>;

/** A sub-agent a running step started and that has not returned yet. */
export const activeSubagentSchema = z.object({
  /** The id of the tool call that runs it. */
  id: z.string().min(1),
  agentType: z.string().min(1),
  description: z.string().nullable(),
  startedAt: timestamp,
});
export type ActiveSubagent = z.infer<typeof activeSubagentSchema>;

/**
 * A running agent step with the task it works on and its open sub-agents
 * (oldest first), for the active agents view.
 */
export const activeAgentStepSchema = stepSchema.extend({
  taskId: id,
  subagents: activeSubagentSchema.array(),
});
export type ActiveAgentStep = z.infer<typeof activeAgentStepSchema>;

/** When a done task was resolved: the time its delivery run finished, for the stats view. */
export const taskDoneTimeSchema = z.object({ taskId: id, doneAt: timestamp });
export type TaskDoneTime = z.infer<typeof taskDoneTimeSchema>;

/** An agent step's usage with its task and when it started, for the task header and stats view. */
export const stepUsageSchema = usageSchema.extend({ taskId: id, stepId: id, at: timestamp });
export type StepUsage = z.infer<typeof stepUsageSchema>;

/** One entry in a step's append-only event log. */
export const stepEventSchema = z.object({
  stepId: id,
  /** 1-based sequence number within the step. */
  seq: z.int().positive(),
  type: z.string().min(1),
  payload: z.unknown(),
  createdAt: timestamp,
});
export type StepEvent = z.infer<typeof stepEventSchema>;

// ---------------------------------------------------------------------------
// Findings and grill questions
// ---------------------------------------------------------------------------

export const findingSchema = z
  .object({
    id,
    taskId: id,
    runId: id.nullable(),
    stepId: id.nullable(),
    reviewerAgentId: id.nullable(),
    severity: severitySchema,
    tags: z.array(z.string().min(1)),
    /** Repo-relative path; null for findings not tied to a file. */
    file: z.string().nullable(),
    lineStart: z.int().positive().nullable(),
    lineEnd: z.int().positive().nullable(),
    title: name,
    explanation: z.string(),
    suggestedFix: z.string().nullable(),
    status: findingStatusSchema,
    /** The finding this duplicate was merged into; null unless `merged`. */
    mergedIntoId: id.nullable(),
    round: z.int().nonnegative(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .refine((f) => f.lineStart == null || f.lineEnd == null || f.lineEnd >= f.lineStart, {
    path: ["lineEnd"],
    message: "lineEnd must not be before lineStart",
  });
export type Finding = z.infer<typeof findingSchema>;

/**
 * One finding as a code reviewer reports it (the findings output contract).
 * The harness adds ids, task/run/step, reviewer and status when storing it.
 */
export const reviewFindingSchema = z
  .object({
    severity: severitySchema,
    tags: z.array(z.string().min(1)),
    file: z.string().nullable(),
    lineStart: z.int().positive().nullable(),
    lineEnd: z.int().positive().nullable(),
    title: name,
    explanation: z.string(),
    suggestedFix: z.string().nullable(),
  })
  .strict();
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

/** A code reviewer's whole output: its findings, empty when the diff is clean. */
export const reviewOutputSchema = z.object({ findings: z.array(reviewFindingSchema) }).strict();
export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

/** JSON Schema of a code reviewer's output, e.g. for Claude's `--json-schema`. */
export function reviewOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(reviewOutputSchema);
}

/** User override on a finding (force fix / force ignore). */
export const findingOverrideInputSchema = z.object({ status: findingOverrideSchema });
export type FindingOverrideInput = z.infer<typeof findingOverrideInputSchema>;

/**
 * The user's comment on one hunk of the branch diff. It becomes a finding on
 * `file`, at the hunk's lines in the new file (null when unknown): force-fixed
 * in a work task, open (to post to the PR) in a review task.
 */
export const diffCommentInputSchema = z
  .object({
    file: z.string().min(1),
    lineStart: z.int().positive().nullable(),
    lineEnd: z.int().positive().nullable(),
    /** The hunk as unified-diff text, header included. */
    hunk: z.string().min(1),
    body: z.string().trim().min(1),
  })
  .refine((c) => c.lineStart == null || c.lineEnd == null || c.lineEnd >= c.lineStart, {
    path: ["lineEnd"],
    message: "lineEnd must not be before lineStart",
  });
export type DiffCommentInput = z.infer<typeof diffCommentInputSchema>;

/** The hunk comments the user sends together from the diff step-through. */
export const diffCommentsInputSchema = z.object({
  comments: z.array(diffCommentInputSchema).min(1),
});
export type DiffCommentsInput = z.infer<typeof diffCommentsInputSchema>;

/** Reply to sent hunk comments: their findings and the task, queued for a fix round at finish or escalation. */
export const diffCommentsResultSchema = z.object({
  findings: findingSchema.array(),
  task: taskSchema,
});
export type DiffCommentsResult = z.infer<typeof diffCommentsResultSchema>;

/** Reply to deleting a review task's finding: its id and those of the duplicates merged into it. */
export const findingDeleteResultSchema = z.object({ deletedIds: id.array() });
export type FindingDeleteResult = z.infer<typeof findingDeleteResultSchema>;

/**
 * Whether a finding is the user's own hunk comment: it has neither a step nor
 * a reviewer. Check-failure findings always carry their step, and reviewer
 * findings carry their agent when created. A step-less reviewer finding whose
 * agent was later deleted (the reference is set to null) matches too.
 */
export function isUserComment(f: Pick<Finding, "stepId" | "reviewerAgentId">): boolean {
  return f.stepId === null && f.reviewerAgentId === null;
}

/** A plan reviewer's question, answered by the planner or, when `needsHuman`, the user. */
export const grillQuestionSchema = z.object({
  id,
  taskId: id,
  runId: id.nullable(),
  stepId: id.nullable(),
  askedByAgentId: id.nullable(),
  question: z.string().min(1),
  /** The planner could not answer from the repo; the user must decide. */
  needsHuman: z.boolean(),
  answer: z.string().nullable(),
  answeredBy: grillAnswererSchema.nullable(),
  createdAt: timestamp,
  answeredAt: timestamp.nullable(),
});
export type GrillQuestion = z.infer<typeof grillQuestionSchema>;

export const grillAnswerInputSchema = z.object({ answer: z.string().trim().min(1) });
export type GrillAnswerInput = z.infer<typeof grillAnswerInputSchema>;

/** Reply to a user's grill answer: the answered question and the task, which moves on once none are open. */
export const grillAnswerResultSchema = z.object({
  question: grillQuestionSchema,
  task: taskSchema,
});
export type GrillAnswerResult = z.infer<typeof grillAnswerResultSchema>;

/**
 * One question as a plan reviewer asks it. `needsHuman`: only the user can
 * decide (a product or scope call), so the planner must not guess.
 */
export const planReviewQuestionSchema = z
  .object({ question: z.string().trim().min(1), needsHuman: z.boolean() })
  .strict();
export type PlanReviewQuestion = z.infer<typeof planReviewQuestionSchema>;

/** A plan reviewer's whole output: its questions, empty when it is satisfied with the plan. */
export const planReviewOutputSchema = z
  .object({ questions: z.array(planReviewQuestionSchema) })
  .strict();
export type PlanReviewOutput = z.infer<typeof planReviewOutputSchema>;

/** JSON Schema of a plan reviewer's output. */
export function planReviewOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(planReviewOutputSchema);
}

/**
 * The planner's reply to a grill round: an answer per numbered question (null
 * when the repository cannot answer it and the user must decide), and the
 * plan revised with those answers.
 */
export const planAnswersOutputSchema = z
  .object({
    answers: z.array(
      z
        .object({
          /** 1-based number of the question in the prompt. */
          question: z.int().positive(),
          answer: z.string().trim().min(1).nullable(),
        })
        .strict(),
    ),
    plan: z.string().trim().min(1),
  })
  .strict();
export type PlanAnswersOutput = z.infer<typeof planAnswersOutputSchema>;

/** JSON Schema of the planner's grill answers. */
export function planAnswersOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(planAnswersOutputSchema);
}

/**
 * The summary and squash message of the summarizer's answer. Not strict, so a
 * bad `shortSummary` or `followUps` value never discards them.
 */
export const summaryCoreSchema = z.object({
  summary: z.string().trim().min(1),
  commitMessage: z.string().trim().min(1),
});

/** The short summary of the summarizer's answer, parsed apart from {@link summaryCoreSchema}. */
export const shortSummarySchema = z.object({
  shortSummary: z.string().trim().min(1),
});

/**
 * The summarizer's final answer: the task summary in markdown, a commit
 * message for squashing the task's commits into one, a short outward summary
 * for PR bodies and comments, optional follow-up tasks and optional memories
 * about the repo. The follow-ups and memories are only checked for shape here
 * (the CLI enforces this schema); {@link parseFollowUps} and
 * {@link parseMemories} drop the invalid ones.
 */
export const summaryOutputSchema = summaryCoreSchema
  .extend({
    shortSummary: z.string().trim().min(1),
    followUps: z.array(followUpWireSchema).optional(),
    memories: z.array(memoryWireSchema).optional(),
  })
  .strict();
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

/** JSON Schema of the summarizer's final answer. */
export function summaryOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(summaryOutputSchema);
}

/**
 * The summarizer's answer when it reads a finished task again to backfill the
 * repo's memories: only the notes, checked for shape; {@link parseMemories}
 * drops the invalid ones.
 */
export const memoryBackfillOutputSchema = z
  .object({ memories: z.array(memoryWireSchema) })
  .strict();
export type MemoryBackfillOutput = z.infer<typeof memoryBackfillOutputSchema>;

/** JSON Schema of the memory backfill's answer. */
export function memoryBackfillOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(memoryBackfillOutputSchema);
}

/**
 * A repo's memory backfill: whether a pass is running, how many finished tasks
 * are still to read (an upper bound, since closed pull requests are skipped
 * without a run), and the counts of the current or last pass.
 */
export const memoryBackfillStatusSchema = z.object({
  running: z.boolean(),
  pending: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  saved: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type MemoryBackfillStatus = z.infer<typeof memoryBackfillStatusSchema>;

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * An action the chat agent proposes; nothing happens until the user applies
 * it. `create-task` adds a free-text backlog item; `message-task` answers a
 * task waiting at a gate; `answer-question` answers one of a task's open grill
 * questions; `stop-task` and `resume-task` stop or resume a task, the latter
 * with optional guidance for the steps that failed or stopped. A plain union on `kind`, so its JSON Schema is an `anyOf`, which every CLI's
 * structured output accepts.
 */
export const chatActionProposalSchema = z.union([
  z
    .object({
      kind: z.literal("create-task"),
      title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
      description: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message-task"),
      taskId: z.string().min(1),
      message: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("answer-question"),
      taskId: z.string().min(1),
      questionId: z.string().min(1),
      answer: z.string().trim().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("stop-task"), taskId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("resume-task"),
      taskId: z.string().min(1),
      message: z.string().trim().min(1).optional(),
    })
    .strict(),
]);
export type ChatActionProposal = z.infer<typeof chatActionProposalSchema>;
export type ChatActionKind = ChatActionProposal["kind"];

/** The chat agent's structured answer: a markdown reply and the actions it proposes. */
export const chatReplySchema = z
  .object({
    reply: z.string(),
    actions: z.array(chatActionProposalSchema),
  })
  .strict();
export type ChatReply = z.infer<typeof chatReplySchema>;

/** JSON Schema of the chat agent's answer. */
export function chatReplyJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(chatReplySchema);
}

/** A proposed action as stored: a server-generated id, and when the user applied it (ISO), or null. */
export const chatActionSchema = z.intersection(
  chatActionProposalSchema,
  z.object({ id, appliedAt: z.string().nullable() }),
);
export type ChatAction = z.infer<typeof chatActionSchema>;

/** `error`: a turn that failed; its text says why. */
export const CHAT_ROLES = ["user", "assistant", "error"] as const;
export const chatRoleSchema = z.enum(CHAT_ROLES);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z.object({
  id,
  role: chatRoleSchema,
  text: z.string(),
  /** Actions the assistant proposed; empty for other roles. */
  actions: z.array(chatActionSchema),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * A chat conversation, stored per repo or per task; `busy`, `activity` and
 * `draft` are live only.
 */
export const chatStateSchema = z.object({
  repoId: id,
  /** null: the repo's chat; set: that task's own conversation. */
  taskId: id.nullable(),
  /** True while the agent answers. */
  busy: z.boolean(),
  /** What the agent is doing right now (e.g. `Grep · useTheme`); null when idle or unknown. */
  activity: z.string().nullable(),
  /**
   * The reply as streamed so far, a preview the validated final reply replaces;
   * null when nothing streams. Live only, never stored.
   */
  draft: z.string().nullable(),
  messages: z.array(chatMessageSchema),
});
export type ChatState = z.infer<typeof chatStateSchema>;

/** The chat message that starts the conversation over. */
export const CHAT_CLEAR_COMMAND = "/clear";

/**
 * `POST /api/repos/:repoId/chat` (the repo's chat) or
 * `POST /api/repos/:repoId/tasks/:taskId/chat` (that task's) body;
 * {@link CHAT_CLEAR_COMMAND} starts over.
 */
export const chatSendInputSchema = z.object({
  text: z.string().trim().min(1),
});
export type ChatSendInput = z.infer<typeof chatSendInputSchema>;

/** Whether an agent CLI is installed, detected at startup via `<cli> --version`. */
export const cliStatusSchema = z.object({
  cli: agentCliSchema,
  installed: z.boolean(),
  /** Semver from `--version`, e.g. `2.1.294`; null when not installed or unparseable. */
  version: z.string().nullable(),
  /** Why detection failed (command not found, non-zero exit, …); null when installed. */
  error: z.string().nullable(),
});
export type CliStatus = z.infer<typeof cliStatusSchema>;

// ---------------------------------------------------------------------------
// Data export and import
// ---------------------------------------------------------------------------

/** Version of the export archive layout; an import refuses any other. */
export const DATA_ARCHIVE_FORMAT = 1;

/** `manifest.json` in an export archive, next to the database copy. */
export const dataManifestSchema = z.object({
  format: z.literal(DATA_ARCHIVE_FORMAT),
  app: z.literal("blackwall"),
  /** Informational only: compatibility is decided by the migration level. */
  blackwallVersion: z.string(),
  exportedAt: z.iso.datetime(),
  /** The last applied migration: how many, its journal tag and its `when`. */
  migration: z.object({
    count: z.int().nonnegative(),
    tag: z.string().nullable(),
    when: z.number(),
  }),
  /** False when agent transcripts (messages and tool calls) were left out. */
  includesTranscripts: z.boolean(),
});
export type DataManifest = z.infer<typeof dataManifestSchema>;

/** `POST /api/data/import`: what was replaced and what still needs the user. */
export const dataImportResultSchema = z.object({
  /** The database as it was before the import. */
  backupPath: z.string(),
  manifest: dataManifestSchema,
  connectionsMissingToken: z.array(connectionViewSchema),
  missingRepos: z.array(z.object({ id, name: z.string(), path: z.string() })),
  tasksMissingWorktree: z.array(z.object({ id, title: z.string(), path: z.string() })),
});
export type DataImportResult = z.infer<typeof dataImportResultSchema>;

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

/** One table's row count and on-disk size (indexes included). */
export const systemTableStatSchema = z.object({
  name: z.string(),
  rows: z.number().int().nonnegative(),
  /** Bytes from SQLite's `dbstat`; null when this SQLite build lacks it. */
  bytes: z.number().int().nonnegative().nullable(),
});
export type SystemTableStat = z.infer<typeof systemTableStatSchema>;

/** Facts about this install: what it stores on disk and what it runs on. */
export const systemInfoSchema = z.object({
  dataDir: z.string(),
  database: z.object({
    /** Absolute path of the database file, or `:memory:`. */
    path: z.string(),
    fileBytes: z.number().int().nonnegative(),
    walBytes: z.number().int().nonnegative(),
    shmBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    /** Whether per-table sizes were available. */
    dbstat: z.boolean(),
    /** Largest first: by bytes, else by rows. */
    tables: systemTableStatSchema.array(),
    migrations: z.object({
      applied: z.number().int().nonnegative(),
      available: z.number().int().nonnegative(),
      /** Tag of the newest migration shipped, e.g. `0016_repo_default_branch`. */
      latest: z.string().nullable(),
    }),
  }),
  worktrees: z.object({
    /** Task worktrees that exist on disk. */
    count: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    artifactBytes: z.number().int().nonnegative(),
    /** All worktrees' size; null unless asked for, since it walks `node_modules`. */
    totalBytes: z.number().int().nonnegative().nullable(),
  }),
  runningTasks: z.number().int().nonnegative(),
  runtime: z.object({
    /** blackwall's version from the root `package.json`; null when unreadable. */
    version: z.string().nullable(),
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    osRelease: z.string(),
    uptimeSeconds: z.number().nonnegative(),
  }),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

/** The stats after compacting the database, and how much it shrank. */
export const compactResultSchema = z.object({
  info: systemInfoSchema,
  freedBytes: z.number().int(),
});
export type CompactResult = z.infer<typeof compactResultSchema>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `all` searches every repo (the current one first); `repo` only the current one. */
export const SEARCH_SCOPES = ["all", "repo"] as const;
export const searchScopeSchema = z.enum(SEARCH_SCOPES);
export type SearchScope = z.infer<typeof searchScopeSchema>;

/** `GET /api/search` query: the text, the current repo and the scope. */
export const searchQuerySchema = z.object({
  q: z.string().trim().max(200),
  /** Listed first; the only repo searched under `repo` scope. */
  repoId: z.string().optional(),
  scope: searchScopeSchema.default("all"),
});
export type SearchQuery = z.input<typeof searchQuerySchema>;

/** A matching task, archived ones included. */
export const searchTaskHitSchema = z.object({
  id,
  title: z.string(),
  repoId: id,
  repoName: z.string(),
  status: taskStatusSchema,
  archived: z.boolean(),
  origin: taskOriginSchema,
  /** Excerpt around the match when it is not in the title; null otherwise. */
  snippet: z.string().nullable(),
});
export type SearchTaskHit = z.infer<typeof searchTaskHitSchema>;

/** A matching waiting or paused backlog item; promoted ones show as their task. */
export const searchBacklogHitSchema = z.object({
  id,
  title: z.string(),
  repoId: id,
  repoName: z.string(),
  status: z.enum(["waiting", "paused"]),
  origin: taskOriginSchema,
  /** Excerpt around the match when it is not in the title; null otherwise. */
  snippet: z.string().nullable(),
});
export type SearchBacklogHit = z.infer<typeof searchBacklogHitSchema>;

/** A registered repo whose name matches. */
export const searchRepoHitSchema = z.object({ id, name: z.string(), path: z.string() });
export type SearchRepoHit = z.infer<typeof searchRepoHitSchema>;

/** `GET /api/search` response, grouped and each group capped. */
export const searchResultsSchema = z.object({
  tasks: z.array(searchTaskHitSchema),
  backlogItems: z.array(searchBacklogHitSchema),
  repos: z.array(searchRepoHitSchema),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

/** The rate the browser resamples to and the recognizer reads, in Hz. */
export const VOICE_SAMPLE_RATE = 16000;
/** The longest clip, in seconds; recording stops itself here. */
export const MAX_VOICE_SECONDS = 30;
/** Shorter clips are dropped as accidental taps. */
export const MIN_VOICE_SECONDS = 0.3;
/** The longest transcript a voice command takes. */
export const MAX_VOICE_COMMAND_CHARS = 2000;

/** `GET /api/voice/status`: whether the chosen model can transcribe, and why not. */
export const voiceStatusSchema = z.object({
  available: z.boolean(),
  model: voiceModelIdSchema,
  reason: z.string().nullable(),
  /** Every model whose files are all in place, chosen or not. */
  installed: z.array(voiceModelIdSchema),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const voiceDownloadPhaseSchema = z.enum([
  "idle",
  "downloading",
  "unpacking",
  "done",
  "failed",
]);
export type VoiceDownloadPhase = z.infer<typeof voiceDownloadPhaseSchema>;

/** `GET /api/voice/download`: the server's one speech model download, as every client sees it. */
export const voiceDownloadSchema = z.object({
  /** The model being or last downloaded; null before the first download. */
  model: voiceModelIdSchema.nullable(),
  phase: voiceDownloadPhaseSchema,
  receivedBytes: z.number(),
  /** The archive size from `content-length`; null when the server does not say. */
  totalBytes: z.number().nullable(),
  /** Why the download failed, in phase `failed`. */
  error: z.string().nullable(),
});
export type VoiceDownload = z.infer<typeof voiceDownloadSchema>;

/** `POST /api/voice/download` body: the model to download. */
export const voiceDownloadInputSchema = z.object({ model: voiceModelIdSchema });
export type VoiceDownloadInput = z.infer<typeof voiceDownloadInputSchema>;

/** `POST /api/voice/transcribe` response. */
export const voiceTranscriptSchema = z.object({ text: z.string() });
export type VoiceTranscript = z.infer<typeof voiceTranscriptSchema>;

/**
 * The New task form a voice command opened, held on the server. `revision`
 * goes up with each change of its fields; `submitting` while it is being
 * created, by voice or the form.
 */
export const voiceDraftSchema = z.object({
  id,
  repoId: id,
  title: z.string(),
  description: z.string(),
  revision: z.int(),
  submitting: z.boolean(),
});
export type VoiceDraft = z.infer<typeof voiceDraftSchema>;

/** What a voice submit created: the backlog item, and its task when it started at once. */
export const voiceCreatedSchema = z.object({
  repoId: id,
  itemId: id,
  taskId: id.nullable(),
  title: z.string(),
});
export type VoiceCreated = z.infer<typeof voiceCreatedSchema>;

/**
 * Something a voice command asks the browser to do: navigation, the selected
 * repo and the chat panel live only there. Only the tab that sent the command
 * applies it, each `id` once.
 */
export const voiceUiActionSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("show-grid") }),
  z.object({ id, kind: z.literal("select-repo"), repoId: id }),
  z.object({ id, kind: z.literal("open-chat") }),
  z.object({ id, kind: z.literal("open-task"), taskId: id }),
]);
export type VoiceUiAction = z.infer<typeof voiceUiActionSchema>;

/** Voice control as every client sees it: the last command, its progress, and the open draft. */
export const voiceStateSchema = z.object({
  /** True while the agent works on a command. */
  busy: z.boolean(),
  /** The repo of the last command. */
  repoId: id.nullable(),
  transcript: z.string().nullable(),
  /** What the agent is doing right now; null when idle or unknown. */
  activity: z.string().nullable(),
  /** The agent's answer to the last command. */
  reply: z.string().nullable(),
  error: z.string().nullable(),
  draft: voiceDraftSchema.nullable(),
  /** Set by the last submit of a draft; cleared by the next command. */
  created: voiceCreatedSchema.nullable(),
  /** The page load that sent the last command; only it applies `actions`. */
  clientId: z.string().nullable(),
  /** UI actions the last command queued, in order; cleared by the next command. */
  actions: z.array(voiceUiActionSchema),
});
export type VoiceState = z.infer<typeof voiceStateSchema>;

/** `POST /api/voice/commands` body: a transcript to act on in a repo. */
export const voiceCommandInputSchema = z.object({
  repoId: z.string().min(1),
  text: z.string().trim().min(1).max(MAX_VOICE_COMMAND_CHARS),
  /** The sending page load, so only it applies the command's UI actions. */
  clientId: z.string().min(1).max(100).optional(),
  /** The task open in the sending tab, which task tools act on. */
  taskId: z.string().min(1).optional(),
});
export type VoiceCommandInput = z.infer<typeof voiceCommandInputSchema>;
