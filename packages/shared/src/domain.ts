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
export const AGENT_CLIS = ["claude", "copilot"] as const;
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
/** Backlog pick order: higher buckets run first. */
export const BACKLOG_PRIORITIES = ["high", "normal", "low"] as const;
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
export const backlogPrioritySchema = z.enum(BACKLOG_PRIORITIES);
export const backlogStatusSchema = z.enum(BACKLOG_STATUSES);

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
export type BacklogPriority = z.infer<typeof backlogPrioritySchema>;
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

export const repoSchema = z.object({
  id,
  /** Absolute path of the local git repo. */
  path: z.string().min(1),
  name,
  remoteUrl: z.string().nullable(),
  connectionId: id.nullable(),
  /** Build/test commands run in the Checks stage; empty = skip. */
  checkCommands: z.array(z.string().trim().min(1)),
  /** CLI new tasks in this repo run their agents on. */
  defaultCli: agentCliSchema,
  /** Origin the new-task and backlog forms open on for this repo. */
  defaultOrigin: originKindSchema,
  /** Listed first, with a star. */
  favorite: z.boolean(),
  /** Manual order among repos in the same favourite group. */
  position: z.int(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Repo = z.infer<typeof repoSchema>;

/** A registry repo as the API returns it, with whether its folder still exists. */
export const repoViewSchema = repoSchema.extend({ exists: z.boolean() });
export type RepoView = z.infer<typeof repoViewSchema>;

/** The repo's local main branch vs `origin/<main>`, as of the last fetch. */
export const repoSyncSchema = z.object({
  branch: z.string().min(1),
  /** Local commits `origin/<main>` doesn't have. */
  ahead: z.int().min(0),
  /** `origin/<main>` commits the local branch doesn't have. */
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
});
export type RepoInput = z.input<typeof repoInputSchema>;

/** Body for editing a repo. The path is fixed once registered. */
export const repoUpdateSchema = z.object({
  name: name.optional(),
  checkCommands: repoSchema.shape.checkCommands.optional(),
  defaultCli: agentCliSchema.optional(),
  defaultOrigin: originKindSchema.optional(),
  favorite: z.boolean().optional(),
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
 * `Bash(npm test:*)`, Copilot: `shell(npm test)`). Added on top of the stage's
 * permission profile; deny rules always win, so an allow cannot undo a built-in deny.
 */
export const permissionOverridesSchema = z.object({
  allow: z.array(z.string().trim().min(1)).optional(),
  deny: z.array(z.string().trim().min(1)).optional(),
});
export type PermissionOverrides = z.infer<typeof permissionOverridesSchema>;

/** Model id per CLI; a CLI without an entry runs the agent on its own default model. */
export const agentModelsSchema = z.partialRecord(agentCliSchema, z.string().trim().min(1));
export type AgentModels = z.infer<typeof agentModelsSchema>;

/** Permission overrides per CLI, since each CLI has its own rule syntax. */
export const agentPermissionOverridesSchema = z.partialRecord(
  agentCliSchema,
  permissionOverridesSchema,
);
export type AgentPermissionOverrides = z.infer<typeof agentPermissionOverridesSchema>;

/**
 * Agent library entry. Agents are not tied to a CLI: a task runs them on its
 * repo's default CLI, or on the CLI chosen for that agent on the task.
 */
export const agentSchema = z.object({
  id,
  name,
  models: agentModelsSchema,
  /** Role prompt / persona. */
  prompt: z.string(),
  eligibleStages: z.array(stageSchema),
  permissionOverrides: agentPermissionOverridesSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Agent = z.infer<typeof agentSchema>;

export const agentInputSchema = agentSchema.pick({ name: true }).extend({
  models: agentModelsSchema.default({}),
  prompt: agentSchema.shape.prompt.default(""),
  eligibleStages: agentSchema.shape.eligibleStages.default([]),
  permissionOverrides: agentPermissionOverridesSchema.default({}),
});
export type AgentInput = z.input<typeof agentInputSchema>;

/** Body for editing an agent; omitted fields keep their value. */
export const agentUpdateSchema = z.object({
  name: agentSchema.shape.name.optional(),
  models: agentModelsSchema.optional(),
  prompt: agentSchema.shape.prompt.optional(),
  eligibleStages: agentSchema.shape.eligibleStages.optional(),
  permissionOverrides: agentPermissionOverridesSchema.optional(),
});
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

export const DEFAULT_MAX_TASKS_PER_REPO = 3;
export const DEFAULT_MAX_BACKLOG_TASKS_PER_REPO = 1;

export const settingsSchema = z.object({
  roleDefaults: roleAgentsSchema.default({}),
  maxTasksPerRepo: z.int().min(1).max(20).default(DEFAULT_MAX_TASKS_PER_REPO),
  /** Whether the backlog runner promotes backlog items on its own (per repo switch on top). */
  backlogRunner: z.boolean().default(true),
  /** How many backlog-originated tasks may be queued or running at once in one repo. */
  maxBacklogTasksPerRepo: z.int().min(1).max(20).default(DEFAULT_MAX_BACKLOG_TASKS_PER_REPO),
  /** Hold a repo's backlog while one of its backlog tasks waits on the user. */
  stopBacklogOnNeedsYou: z.boolean().default(true),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

/** Settings other than the role defaults (which live under `/api/agents/role-defaults`). */
export const generalSettingsSchema = settingsSchema.omit({ roleDefaults: true });
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

/** Body for editing the general settings; omitted fields keep their value. */
export const generalSettingsUpdateSchema = z.object({
  maxTasksPerRepo: settingsSchema.shape.maxTasksPerRepo.unwrap().optional(),
  backlogRunner: z.boolean().optional(),
  maxBacklogTasksPerRepo: settingsSchema.shape.maxBacklogTasksPerRepo.unwrap().optional(),
  stopBacklogOnNeedsYou: z.boolean().optional(),
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

export const githubPrOriginSchema = z.object({
  kind: z.literal("github-pr"),
  url: z.url(),
  owner: name,
  repo: name,
  number: z.int().positive(),
  connectionId: id.nullable(),
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

/** A registry repo plus the task's own worktree and branch (set once created). */
export const workspaceSchema = z.object({
  repoId: id,
  branch: z.string().nullable(),
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
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine(checkMode);
export type Task = z.infer<typeof taskSchema>;

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
    triageMode: triageModeSchema.default("intervene"),
    /**
     * GitHub issue tasks only: a comment the user confirmed, posted on the
     * issue when the task is created. Omitted: nothing is posted.
     */
    startComment: issueCommentInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    checkMode(value, ctx);
    if (value.origin.kind === "free-text" && value.freeText.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["freeText"], message: "Describe the task" });
    }
    checkStartComment(value, ctx);
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
    triageMode: triageModeSchema,
    priority: backlogPrioritySchema,
    /** Manual order inside a priority bucket. */
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
    triageMode: triageModeSchema.default("intervene"),
    priority: backlogPrioritySchema.default("normal"),
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
  priority: backlogPrioritySchema.optional(),
  dependsOn: backlogDependsOn.optional(),
  /** Hold an item back or release it; promotion happens through `run`. */
  status: z.enum(["waiting", "paused"]).optional(),
  agents: roleAgentsSchema.optional(),
  agentClis: agentClisSchema.optional(),
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
});
export type RepoBacklogRunner = z.infer<typeof repoBacklogRunnerSchema>;

/** `PATCH /api/repos/:repoId/backlog/runner` body. */
export const repoBacklogRunnerUpdateSchema = z.object({ enabled: z.boolean() });
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

/** Scratch folder in a task's worktree; ignored by its own `.gitignore`. */
export const SCRATCH_DIR = ".blackwall";

/** An image an implementer saved to `.blackwall/artifacts/` in the task's worktree. */
export const taskArtifactSchema = z.object({
  /** Relative to the artifacts folder, `/`-separated. */
  path: z.string(),
  size: z.int().nonnegative(),
  modifiedAt: timestamp,
});
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * One delivery action as offered at finish, with exactly where it goes and
 * what it sends, so the user confirms the real target rather than a label.
 */
export const deliveryActionSchema = z.discriminatedUnion("kind", [
  /** Push the task branch to `remote` under the same name. Never main. */
  z.object({ kind: z.literal("push-branch"), branch: z.string(), remote: z.string() }),
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
  /** Submit a review on the pull request at `url` with the selected findings as inline comments. */
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

/** Extra instructions typed into a task's input bar. */
export const taskMessageInputSchema = z.object({ text: z.string().trim().min(1) });
export type TaskMessageInput = z.infer<typeof taskMessageInputSchema>;

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

/** One agent (or harness) invocation within a run. */
export const stepSchema = z.object({
  id,
  runId: id,
  stage: stageSchema,
  /** Null for harness-run steps such as checks, or when the agent was deleted. */
  agentId: id.nullable(),
  /** CLI the agent ran on; null for harness-run steps. */
  cli: agentCliSchema.nullable(),
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
});
export type Step = z.infer<typeof stepSchema>;

/** A running agent step with the task it works on, for the active agents view. */
export const activeAgentStepSchema = stepSchema.extend({ taskId: id });
export type ActiveAgentStep = z.infer<typeof activeAgentStepSchema>;

/** When a done task was resolved: the time its delivery run finished, for the stats view. */
export const taskDoneTimeSchema = z.object({ taskId: id, doneAt: timestamp });
export type TaskDoneTime = z.infer<typeof taskDoneTimeSchema>;

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
 * for PR bodies and comments, and optional follow-up tasks. The follow-ups are
 * only checked for shape here (the CLI enforces this schema);
 * {@link parseFollowUps} drops the invalid ones.
 */
export const summaryOutputSchema = summaryCoreSchema
  .extend({
    shortSummary: z.string().trim().min(1),
    followUps: z.array(followUpWireSchema).optional(),
  })
  .strict();
export type SummaryOutput = z.infer<typeof summaryOutputSchema>;

/** JSON Schema of the summarizer's final answer. */
export function summaryOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(summaryOutputSchema);
}

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
