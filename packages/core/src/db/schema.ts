import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const CONNECTION_KINDS = ["github", "jira"] as const;
export const AGENT_CLIS = ["claude", "copilot"] as const;
export const ORIGIN_KINDS = ["jira-issue", "github-pr", "free-text"] as const;
export const PR_MODES = ["work", "review"] as const;
export const TRIAGE_MODES = ["intervene", "pause"] as const;
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
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const FINDING_STATUSES = ["open", "fixed", "force-fix", "force-ignore"] as const;
export const GRILL_ANSWERERS = ["agent", "user"] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export type AgentCli = (typeof AGENT_CLIS)[number];
export type OriginKind = (typeof ORIGIN_KINDS)[number];
export type PrMode = (typeof PR_MODES)[number];
export type TriageMode = (typeof TRIAGE_MODES)[number];
export type Stage = (typeof STAGES)[number];
export type StepStatus = (typeof STEP_STATUSES)[number];
export type Severity = (typeof SEVERITIES)[number];
export type FindingStatus = (typeof FINDING_STATUSES)[number];
export type GrillAnswerer = (typeof GRILL_ANSWERERS)[number];

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface PermissionOverrides {
  allow?: string[];
  deny?: string[];
}

/** Agent library entries. */
export const agents = sqliteTable("agents", {
  id: id(),
  name: text("name").notNull().unique(),
  cli: text("cli", { enum: AGENT_CLIS }).notNull(),
  model: text("model"),
  prompt: text("prompt").notNull().default(""),
  eligibleStages: text("eligible_stages", { mode: "json" })
    .$type<Stage[]>()
    .notNull()
    .default(sql`'[]'`),
  permissionOverrides: text("permission_overrides", { mode: "json" })
    .$type<PermissionOverrides>()
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

/** Agents chosen per role for a task (role defaults, possibly overridden). */
export interface TaskAgents {
  planner?: string;
  planReviewers?: string[];
  implementer?: string;
  codeReviewers?: string[];
  summarizer?: string;
}

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    title: text("title").notNull(),
    originKind: text("origin_kind", { enum: ORIGIN_KINDS }).notNull(),
    /** Origin details: Jira key + connection, PR URL/number, … */
    origin: text("origin", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    /** PR tasks only. */
    mode: text("mode", { enum: PR_MODES }),
    repoId: text("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "restrict" }),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    status: text("status").notNull().default("pending"),
    triageMode: text("triage_mode", { enum: TRIAGE_MODES }).notNull().default("intervene"),
    agents: text("agents", { mode: "json" })
      .$type<TaskAgents>()
      .notNull()
      .default(sql`'{}'`),
    deliveryTargets: text("delivery_targets", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    freeText: text("free_text").notNull().default(""),
    plan: text("plan"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_repo_idx").on(t.repoId), index("tasks_branch_idx").on(t.repoId, t.branch)],
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
    /** Fix round within the stage loop (0 for the first pass). */
    round: integer("round").notNull().default(0),
    status: text("status", { enum: STEP_STATUSES }).notNull().default("pending"),
    /** CLI session id, used for `--resume`. */
    sessionId: text("session_id"),
    error: text("error"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
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
    /** Set when the planner can answer from the repo; otherwise the question goes to the user. */
    answer: text("answer"),
    answeredBy: text("answered_by", { enum: GRILL_ANSWERERS }),
    createdAt: createdAt(),
    answeredAt: timestamp("answered_at"),
  },
  (t) => [index("grill_questions_task_idx").on(t.taskId)],
);

export type Setting = typeof settings.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type Repo = typeof repos.$inferSelect;
export type NewRepo = typeof repos.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type StepEvent = typeof stepEvents.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type GrillQuestion = typeof grillQuestions.$inferSelect;
export type NewGrillQuestion = typeof grillQuestions.$inferInsert;
