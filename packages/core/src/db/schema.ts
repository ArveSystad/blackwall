import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  AGENT_CLIS,
  BACKLOG_PRIORITIES,
  BACKLOG_STATUSES,
  CHAT_ROLES,
  CONNECTION_KINDS,
  FINDING_STATUSES,
  GATES,
  GRILL_ANSWERERS,
  ORIGIN_KINDS,
  PR_MODES,
  STAGES,
  STEP_STATUSES,
  SEVERITIES,
  TASK_STATUSES,
  TRIAGE_MODES,
  type AgentClis,
  type AgentModels,
  type AgentPermissionOverrides,
  type ChatAction,
  type DeliveryTarget,
  type FollowUp,
  type RoleAgents,
  type Stage,
  type TaskCi,
  type TaskOrigin,
} from "@blackwall/shared";

/** Milliseconds since epoch, surfaced as `Date`. */
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());
const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** Key/value app settings (role defaults, concurrency cap, …); values are JSON. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: updatedAt(),
});

/** GitHub/GHE hosts and Jira Cloud sites. Secrets live in the OS keychain, never here. */
export const connections = sqliteTable("connections", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind", { enum: CONNECTION_KINDS }).notNull(),
  baseUrl: text("base_url").notNull(),
  /** Non-secret auth metadata, e.g. the Jira account email. */
  authMeta: text("auth_meta", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'`),
  /** Whether a token is stored in the keychain for this connection. */
  tokenSet: integer("token_set", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repos = sqliteTable("repos", {
  id: id(),
  path: text("path").notNull().unique(),
  name: text("name").notNull(),
  remoteUrl: text("remote_url"),
  connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
  checkCommands: text("check_commands", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  defaultCli: text("default_cli", { enum: AGENT_CLIS }).notNull().default("claude"),
  defaultOrigin: text("default_origin", { enum: ORIGIN_KINDS }).notNull().default("jira-issue"),
  maxBacklogTasks: integer("max_backlog_tasks"),
  /** Branch new tasks fork from, free-text tasks merge into and PRs target. */
  defaultBranch: text("default_branch").notNull().default("main"),
  /** Listed first, with a star. */
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  /** Manual order among repos in the same favourite group. */
  position: integer("position").notNull().default(0),
  /** Watch CI on GitHub/GHE remotes after a task pushes its branch. */
  watchCi: integer("watch_ci", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Agent library entries. */
export const agents = sqliteTable("agents", {
  id: id(),
  name: text("name").notNull().unique(),
  /** Model id per CLI; a CLI without one uses its own default. */
  models: text("models", { mode: "json" })
    .$type<AgentModels>()
    .notNull()
    .default(sql`'{}'`),
  prompt: text("prompt").notNull().default(""),
  eligibleStages: text("eligible_stages", { mode: "json" })
    .$type<Stage[]>()
    .notNull()
    .default(sql`'[]'`),
  permissionOverrides: text("permission_overrides", { mode: "json" })
    .$type<AgentPermissionOverrides>()
    .notNull()
    .default(sql`'{}'`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Finding tags injected into reviewer prompts; `position` is the display order. */
export const tags = sqliteTable("tags", {
  name: text("name").primaryKey(),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    title: text("title").notNull(),
    /** Jira issue, GitHub PR or free text; discriminated on `kind`. */
    origin: text("origin", { mode: "json" }).$type<TaskOrigin>().notNull(),
    /** PR tasks only. */
    mode: text("mode", { enum: PR_MODES }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict" }),
    branch: text("branch"),
    /** PR tasks: the pull request's base branch when the worktree was created; the fork point for its diffs. */
    baseBranch: text("base_branch"),
    worktreePath: text("worktree_path"),
    status: text("status", { enum: TASK_STATUSES }).notNull().default("queued"),
    /** Current pipeline stage; null before the first step starts. */
    stage: text("stage", { enum: STAGES }),
    /** What the task waits on while `needs-you`. */
    gate: text("gate", { enum: GATES }),
    /** Why the task failed. */
    error: text("error"),
    triageMode: text("triage_mode", { enum: TRIAGE_MODES }).notNull().default("intervene"),
    agents: text("agents", { mode: "json" })
      .$type<RoleAgents>()
      .notNull()
      .default(sql`'{}'`),
    /** The repo's default CLI when the task was created. */
    cli: text("cli", { enum: AGENT_CLIS }).notNull().default("claude"),
    /** Agents run on another CLI than `cli`. */
    agentClis: text("agent_clis", { mode: "json" })
      .$type<AgentClis>()
      .notNull()
      .default(sql`'{}'`),
    deliveryTargets: text("delivery_targets", { mode: "json" })
      .$type<DeliveryTarget[]>()
      .notNull()
      .default(sql`'[]'`),
    /** True while delivery runs at finish. */
    delivering: integer("delivering", { mode: "boolean" }).notNull().default(false),
    freeText: text("free_text").notNull().default(""),
    plan: text("plan"),
    /** The summarizer's final summary; null until Summarize. */
    summary: text("summary"),
    /** Brief, outward summary for PR bodies and comments at finish; null until Summarize. */
    shortSummary: text("short_summary"),
    /** Commit message for the optional squash at finish. */
    squashMessage: text("squash_message"),
    /** Follow-up tasks the summarizer proposed, offered at finish. */
    followUps: text("follow_ups", { mode: "json" })
      .$type<FollowUp[]>()
      .notNull()
      .default(sql`'[]'`),
    /** When the user archived the done task; null while it is listed. */
    archivedAt: timestamp("archived_at"),
    /** CI on the commit the task last pushed; null when it was never watched. */
    ci: text("ci", { mode: "json" }).$type<TaskCi>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_repo_idx").on(t.repoId), index("tasks_branch_idx").on(t.repoId, t.branch)],
);

/** Per-repo backlog: work parked until it is promoted to a task. */
export const backlogItems = sqliteTable(
  "backlog_items",
  {
    id: id(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    origin: text("origin", { mode: "json" }).$type<TaskOrigin>().notNull(),
    /** PR origins only. */
    mode: text("mode", { enum: PR_MODES }),
    freeText: text("free_text").notNull().default(""),
    agents: text("agents", { mode: "json" })
      .$type<RoleAgents>()
      .notNull()
      .default(sql`'{}'`),
    /** Agents to run on another CLI than the repo's default. */
    agentClis: text("agent_clis", { mode: "json" })
      .$type<AgentClis>()
      .notNull()
      .default(sql`'{}'`),
    triageMode: text("triage_mode", { enum: TRIAGE_MODES }).notNull().default("intervene"),
    priority: text("priority", { enum: BACKLOG_PRIORITIES }).notNull().default("normal"),
    /** Manual order inside a priority bucket. */
    position: integer("position").notNull().default(0),
    /** Backlog item ids that must be done first. */
    dependsOn: text("depends_on", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status", { enum: BACKLOG_STATUSES }).notNull().default("waiting"),
    /** Set when promoted. */
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** The task that proposed it as a follow-up. */
    sourceTaskId: text("source_task_id").references(() => tasks.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("backlog_items_repo_status_idx").on(t.repoId, t.status)],
);

/** Per-repo chat conversation, oldest first. */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: id(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    role: text("role", { enum: CHAT_ROLES }).notNull(),
    text: text("text").notNull().default(""),
    /** Proposed actions as clients see them, including `appliedAt`. */
    actions: text("actions", { mode: "json" })
      .$type<ChatAction[]>()
      .notNull()
      .default(sql`'[]'`),
    /** Assistant turns: the CLI session the turn ended on, used for `--resume`. */
    sessionId: text("session_id"),
    /** The CLI that session belongs to. */
    cli: text("cli", { enum: AGENT_CLIS }),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_repo_idx").on(t.repoId, t.createdAt)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** 1-based run number within the task. */
    number: integer("number").notNull(),
    status: text("status", { enum: STEP_STATUSES }).notNull().default("pending"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [uniqueIndex("runs_task_number_idx").on(t.taskId, t.number)],
);

export const steps = sqliteTable(
  "steps",
  {
    id: id(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: STAGES }).notNull(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** CLI the agent ran on; null for harness steps. */
    cli: text("cli", { enum: AGENT_CLIS }),
    /** Fix round within the stage loop (0 for the first pass). */
    round: integer("round").notNull().default(0),
    /** Visit of the stage within the run (0 for the first). */
    visit: integer("visit").notNull().default(0),
    status: text("status", { enum: STEP_STATUSES }).notNull().default("pending"),
    /** CLI session id, used for `--resume`. */
    sessionId: text("session_id"),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    /** Tokens used over all attempts, sub-agents included. */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    /** Cost in USD; null when the CLI reported none. */
    costUsd: real("cost_usd"),
  },
  (t) => [index("steps_run_idx").on(t.runId), index("steps_status_idx").on(t.status)],
);

/** Append-only streamed event log for a step. */
export const stepEvents = sqliteTable(
  "step_events",
  {
    stepId: text("step_id")
      .notNull()
      .references(() => steps.id, { onDelete: "cascade" }),
    /** 1-based sequence number within the step. */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.stepId, t.seq] })],
);

export const findings = sqliteTable(
  "findings",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, { onDelete: "set null" }),
    reviewerAgentId: text("reviewer_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    severity: text("severity", { enum: SEVERITIES }).notNull(),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    file: text("file"),
    lineStart: integer("line_start"),
    lineEnd: integer("line_end"),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(),
    suggestedFix: text("suggested_fix"),
    status: text("status", { enum: FINDING_STATUSES }).notNull().default("open"),
    mergedIntoId: text("merged_into_id").references((): AnySQLiteColumn => findings.id, {
      onDelete: "set null",
    }),
    round: integer("round").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("findings_task_idx").on(t.taskId)],
);

export const grillQuestions = sqliteTable(
  "grill_questions",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, { onDelete: "set null" }),
    askedByAgentId: text("asked_by_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    question: text("question").notNull(),
    /** The planner could not answer from the repo; the user must decide. */
    needsHuman: integer("needs_human", { mode: "boolean" }).notNull().default(false),
    answer: text("answer"),
    answeredBy: text("answered_by", { enum: GRILL_ANSWERERS }),
    createdAt: createdAt(),
    answeredAt: timestamp("answered_at"),
  },
  (t) => [index("grill_questions_task_idx").on(t.taskId)],
);

// Row types for inserts. Reads are typed with the domain types from @blackwall/shared,
// so the compiler checks that every table matches its shared schema.
export type NewConnection = typeof connections.$inferInsert;
export type NewRepo = typeof repos.$inferInsert;
export type NewAgent = typeof agents.$inferInsert;
export type NewTask = typeof tasks.$inferInsert;
export type NewBacklogItem = typeof backlogItems.$inferInsert;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type NewRun = typeof runs.$inferInsert;
export type NewStep = typeof steps.$inferInsert;
export type NewFinding = typeof findings.$inferInsert;
export type NewGrillQuestion = typeof grillQuestions.$inferInsert;
