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
export const ORIGIN_KINDS = ["jira-issue", "github-pr", "free-text"] as const;
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
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
/** Severities that block the code review loop. */
export const GATING_SEVERITIES = ["critical", "high"] as const satisfies readonly Severity[];
export const FINDING_STATUSES = ["open", "fixed", "force-fix", "force-ignore"] as const;
/** Finding statuses the user can set by hand. */
export const FINDING_OVERRIDES = ["force-fix", "force-ignore"] as const;
export const GRILL_ANSWERERS = ["agent", "user"] as const;
/** Outward actions offered at finish; agents never perform these themselves. */
export const DELIVERY_TARGETS = [
  "push-branch",
  "open-pr",
  "pr-comment",
  "pr-review",
  "jira-comment",
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

export function isGatingSeverity(severity: Severity): boolean {
  return (GATING_SEVERITIES as readonly Severity[]).includes(severity);
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const id = z.string().min(1);
const timestamp = z.coerce.date();
const name = z.string().trim().min(1);

export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-\d+$/;

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
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Repo = z.infer<typeof repoSchema>;

/** A registry repo as the API returns it, with whether its folder still exists. */
export const repoViewSchema = repoSchema.extend({ exists: z.boolean() });
export type RepoView = z.infer<typeof repoViewSchema>;

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
});
export type RepoUpdate = z.infer<typeof repoUpdateSchema>;

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

/** Agent library entry. */
export const agentSchema = z.object({
  id,
  name,
  cli: agentCliSchema,
  /** CLI default when null. */
  model: z.string().nullable(),
  /** Role prompt / persona. */
  prompt: z.string(),
  eligibleStages: z.array(stageSchema),
  permissionOverrides: permissionOverridesSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type Agent = z.infer<typeof agentSchema>;

export const agentInputSchema = agentSchema.pick({ name: true, cli: true }).extend({
  model: agentSchema.shape.model.default(null),
  prompt: agentSchema.shape.prompt.default(""),
  eligibleStages: agentSchema.shape.eligibleStages.default([]),
  permissionOverrides: permissionOverridesSchema.default({}),
});
export type AgentInput = z.input<typeof agentInputSchema>;

/** Body for editing an agent; omitted fields keep their value. */
export const agentUpdateSchema = z.object({
  name: agentSchema.shape.name.optional(),
  cli: agentSchema.shape.cli.optional(),
  model: agentSchema.shape.model.optional(),
  prompt: agentSchema.shape.prompt.optional(),
  eligibleStages: agentSchema.shape.eligibleStages.optional(),
  permissionOverrides: permissionOverridesSchema.optional(),
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

export const DEFAULT_MAX_TASKS_PER_REPO = 3;

export const settingsSchema = z.object({
  roleDefaults: roleAgentsSchema.default({}),
  maxTasksPerRepo: z.int().min(1).max(20).default(DEFAULT_MAX_TASKS_PER_REPO),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.input<typeof settingsSchema>;

/** Settings other than the role defaults (which live under `/api/agents/role-defaults`). */
export const generalSettingsSchema = settingsSchema.pick({ maxTasksPerRepo: true });
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

/** Body for editing the general settings; omitted fields keep their value. */
export const generalSettingsUpdateSchema = z.object({
  maxTasksPerRepo: settingsSchema.shape.maxTasksPerRepo.unwrap().optional(),
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

export const freeTextOriginSchema = z.object({ kind: z.literal("free-text") });

export const taskOriginSchema = z.discriminatedUnion("kind", [
  jiraIssueOriginSchema,
  githubPrOriginSchema,
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
    /** Why the task failed; null unless `failed`. */
    error: z.string().nullable(),
    triageMode: triageModeSchema,
    agents: roleAgentsSchema,
    deliveryTargets: z.array(deliveryTargetSchema),
    freeText: z.string(),
    plan: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .superRefine(checkMode);
export type Task = z.infer<typeof taskSchema>;

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
    triageMode: triageModeSchema.default("intervene"),
  })
  .superRefine((value, ctx) => {
    checkMode(value, ctx);
    if (value.origin.kind === "free-text" && value.freeText.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["freeText"], message: "Describe the task" });
    }
  });
export type NewTaskInput = z.input<typeof newTaskInputSchema>;

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

/** Body for answering the gate a `needs-you` task waits on. */
export const gateResponseInputSchema = z.object({
  /** The gate being answered; must match the task's current gate. */
  gate: gateSchema,
  decision: gateDecisionSchema,
  /** Instructions passed to the next stage, e.g. the requested plan changes. */
  message: z.string().trim().min(1).optional(),
});
export type GateResponseInput = z.infer<typeof gateResponseInputSchema>;

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
