import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCli,
  DeliveryAction,
  ReviewFinding,
  ServerEvent,
  Stage,
  Task,
} from "@blackwall/shared";
import { vi } from "vitest";
import type { AgentRunOptions } from "../agents/adapters/types.js";
import type { QuotaTracker } from "../agents/quota.js";
import { createAgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import type { GitService } from "../git/service.js";
import type { RepoRenameLocks } from "../repos/rename-lock.js";
import { openTestDatabase } from "../testing/index.js";
import type { CiWatcher } from "./ci.js";
import { RESUME_PROMPT, createPipelineEngine, type StageHandlers } from "./engine.js";
import { createFakeAdapter, type FakeScript } from "./fake-adapter.js";
import {
  SECURE_PLAYBOOK_ENTRY,
  SECURE_PLAYBOOK_SOURCE,
  installSecurePlaybook,
} from "./playbook.js";
import type { DeliveryContext } from "./delivery.js";
import type { WorktreeSetup } from "./setup.js";
import type { PullRequestFeedback } from "./pr-feedback.js";
import type { PrHeadSync, WorkspaceArchiver, WorkspaceSync } from "./workspace.js";
import { createDefaultStages as createStages, type DefaultStagesOptions } from "./stages.js";

// The engine harness the `engine*.test.ts` files share: fake agents, a task
// seeded in a fresh test database, and the per-test directory and database as
// live bindings. Each test file registers `openEngineTest` and `closeEngineTest`
// itself; only this module assigns `dir`, `opened` and `r`.

export let dir: string;
export let opened: OpenedDatabase;
export let r: Repositories;

/** A fresh directory and test database for one test: register with `beforeEach`. */
export function openEngineTest(): void {
  dir = mkdtempSync(join(tmpdir(), "blackwall-pipeline-"));
  opened = openTestDatabase(dir);
  r = createRepositories(opened.db);
}

/** Closes and reopens the database over the same directory, as a restart does. */
export function reopenEngineDatabase(): void {
  opened.close();
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
}

/** Closes the database and removes the directory: register with `afterEach`. */
export function closeEngineTest(): void {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The default stages without copying the security playbook (hundreds of
 * files) into the worktree on every Code review visit, which made tests with
 * several rounds time out when the suite runs in parallel. Tests that check the
 * copy pass {@link installPlaybookEntry}.
 */
export function createDefaultStages(options: DefaultStagesOptions = {}) {
  return createStages({ installPlaybook: async () => undefined, ...options });
}

/** Installs a playbook of only its entry file, copied from the vendored one. */
export async function installPlaybookEntry(worktree: string): Promise<void> {
  const source = join(dir, "playbook-source");
  mkdirSync(source, { recursive: true });
  copyFileSync(
    join(SECURE_PLAYBOOK_SOURCE, SECURE_PLAYBOOK_ENTRY),
    join(source, SECURE_PLAYBOOK_ENTRY),
  );
  await installSecurePlaybook(worktree, source);
}

export const highFinding: ReviewFinding = {
  severity: "high",
  tags: ["correctness"],
  file: "src/login.ts",
  lineStart: 3,
  lineEnd: 4,
  title: "Password compared with ==",
  explanation: "Type coercion lets an empty password through.",
  suggestedFix: "Use ===",
};

/**
 * Which stage an agent call belongs to, from its prompt. Plan review runs the
 * reviewers (`plan-review`), the planner's answers (`plan-answers`) and the
 * planner folding the user's answers into the plan (`plan-fold`); Checks runs
 * the summarizer's commit message (`commit`) and its rewrites after a
 * commit-msg hook rejected one (`commit-rewrite`).
 */
export type Call =
  Stage | "plan-answers" | "plan-fold" | "commit" | "commit-rewrite" | "resolve-conflicts";

export function stageOf(options: AgentRunOptions): Call {
  if (options.prompt === RESUME_PROMPT) return "implement";
  if (options.prompt.includes("the rebase stopped on conflicts")) return "resolve-conflicts";
  if (options.prompt.includes("commit-msg hook rejected this commit message")) {
    return "commit-rewrite";
  }
  if (options.prompt.includes("Write the git commit message")) return "commit";
  if (options.prompt.includes("Grill this plan")) return "plan-review";
  if (options.prompt.includes("Reviewers' questions")) return "plan-answers";
  if (options.prompt.includes("The user has answered")) return "plan-fold";
  if (options.prompt.includes("Summarize the changes")) return "summarize";
  if (options.jsonSchema) return "code-review";
  if (options.prompt.includes("write a concrete implementation plan")) return "inform";
  return "implement";
}

/**
 * Plan reviewers are satisfied, the planner keeps the plan and code reviewers
 * find nothing unless a script says otherwise.
 */
export function withPlanDefaults(stage: Call, script: FakeScript): FakeScript {
  if (script.structured !== undefined || script.fail !== undefined || script.hang) return script;
  if (stage === "plan-review") return { ...script, structured: { questions: [] } };
  if (stage === "code-review") return { ...script, structured: { findings: [] } };
  if (stage === "plan-answers") {
    return { ...script, structured: { answers: [], plan: "revised plan" } };
  }
  return script;
}

export const ISSUE_COMMENT_URL = "https://github.com/acme/app/issues/7#issuecomment-1";

export interface Harness {
  engine: ReturnType<typeof createPipelineEngine>;
  calls: { stage: Call; cli: AgentCli; options: AgentRunOptions }[];
  events: ServerEvent[];
  delivered: string[];
  /** Delivery calls, with what the user confirmed. */
  deliveries: DeliveryContext[];
}

export function harness(
  script: (stage: Call, options: AgentRunOptions) => FakeScript = () => ({}),
  {
    stages = createDefaultStages(),
    maxPerRepo = 3,
    deliver = async () => undefined,
    quota,
    removeWorkspace,
    archiveWorkspace,
    beforeDelete,
    commentOnIssue = async () => ({ url: ISSUE_COMMENT_URL }),
    pathExists,
    ci,
    prFeedback,
    prepareWorkspace,
    prBranchOwned,
    worktreeGuard,
    syncWorkspace,
    log = () => undefined,
    autonomous,
    planActions = [],
    setup,
    prHead,
    renaming,
  }: {
    stages?: StageHandlers;
    maxPerRepo?: number;
    deliver?: (ctx: DeliveryContext) => Promise<void>;
    quota?: Pick<QuotaTracker, "report" | "succeeded">;
    removeWorkspace?: (task: Task) => Promise<void>;
    archiveWorkspace?: WorkspaceArchiver;
    beforeDelete?: (taskId: string) => Promise<void>;
    commentOnIssue?: (task: Task, body: string) => Promise<{ url: string }>;
    pathExists?: (path: string) => boolean;
    ci?: Pick<CiWatcher, "watch" | "cancel" | "failureContext">;
    prFeedback?: (url: string) => Promise<PullRequestFeedback>;
    prepareWorkspace?: (task: Task) => Promise<{ branch: string; worktreePath: string }>;
    prBranchOwned?: (task: Task, signal: AbortSignal) => Promise<boolean>;
    worktreeGuard?: Pick<GitService, "snapshotWorktree" | "restoreWorktree">;
    syncWorkspace?: (task: Task) => Promise<WorkspaceSync | null>;
    log?: (message: string) => void;
    autonomous?: (task: Task) => boolean;
    /** The delivery actions offered at finish (none by default). */
    planActions?: DeliveryAction[];
    setup?: WorktreeSetup;
    prHead?: PrHeadSync;
    renaming?: RepoRenameLocks;
  } = {},
): Harness {
  const agents = agentService();
  const calls: Harness["calls"] = [];
  const run = (cli: AgentCli) => (options: AgentRunOptions) => {
    const stage = stageOf(options);
    calls.push({ stage, cli, options });
    return withPlanDefaults(stage, script(stage, options));
  };
  const events: ServerEvent[] = [];
  const delivered: string[] = [];
  const deliveries: DeliveryContext[] = [];
  const engine = createPipelineEngine({
    repositories: r,
    invocation: agents.invocation,
    adapters: {
      claude: createFakeAdapter("claude", run("claude")),
      copilot: createFakeAdapter("copilot", run("copilot")),
    },
    stages,
    prepareWorkspace:
      prepareWorkspace ??
      (async (task) => ({
        branch: task.branch ?? `agent/${task.id}`,
        worktreePath: dir,
      })),
    delivery: {
      plan: async (_task, completed) => ({
        actions: planActions,
        squash: null,
        completed: completed.filter((c) => c !== "squash"),
      }),
      deliver: async (ctx) => {
        deliveries.push(ctx);
        await deliver(ctx);
        delivered.push(ctx.task.id);
      },
      commentOnIssue: (t, body) => commentOnIssue(t, body),
    },
    maxTasksPerRepo: () => maxPerRepo,
    ...(quota ? { quota } : {}),
    ...(removeWorkspace ? { removeWorkspace } : {}),
    ...(archiveWorkspace ? { archiveWorkspace } : {}),
    ...(beforeDelete ? { beforeDelete } : {}),
    ...(pathExists ? { pathExists } : {}),
    ...(ci ? { ci } : {}),
    ...(prFeedback ? { prFeedback } : {}),
    ...(prBranchOwned ? { prBranchOwned } : {}),
    ...(worktreeGuard ? { worktreeGuard } : {}),
    ...(syncWorkspace ? { syncWorkspace } : {}),
    ...(autonomous ? { autonomous } : {}),
    ...(setup ? { setup } : {}),
    ...(prHead ? { prHead } : {}),
    ...(renaming ? { renaming } : {}),
    publish: (event) => events.push(event),
    log,
  });
  return { engine, calls, events, delivered, deliveries };
}

export function agentService() {
  return createAgentService({
    agents: r.agents,
    settings: r.settings,
    tags: r.tags,
    repos: r.repos,
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    transaction: r.transaction,
  });
}

export function seedTask(
  patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {},
): Task {
  const agents = agentService();
  agents.seed();
  const repo = r.repos.getByPath("/code/app") ?? r.repos.create({ path: "/code/app", name: "app" });
  return r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    freeText: "Login accepts empty passwords",
    agents: agents.resolveRoles(),
    ...patch,
  });
}

export const task = (id: string) => r.tasks.get(id)!;

export async function settle(engine: Harness["engine"]) {
  await engine.idle();
}

export function prOrigin() {
  return {
    kind: "github-pr" as const,
    url: "https://github.com/acme/app/pull/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };
}

export function stepsOf(taskId: string) {
  return r.runs.listByTask(taskId).flatMap((run) => r.steps.listByRun(run.id));
}

export function lastStep(taskId: string) {
  return stepsOf(taskId).at(-1)!;
}

/** An archiver port that touches no git, recording what it was asked to do in `order`. */
export function fakeArchiver(order: string[] = []) {
  return {
    order,
    archive: vi.fn<WorkspaceArchiver["archive"]>(async (t) => {
      order.push(`archive ${t.id}`);
      return { sha: "head" };
    }),
    restore: vi.fn<WorkspaceArchiver["restore"]>(async (t) => {
      order.push(`restore ${t.id}`);
      return { worktreePath: dir, branch: t.branch ?? `agent/${t.id}` };
    }),
    forget: vi.fn<WorkspaceArchiver["forget"]>(async () => undefined),
    exclusive: vi.fn<WorkspaceArchiver["exclusive"]>(async (repoId, fn) => {
      order.push(`exclusive ${repoId}`);
      return fn();
    }),
  };
}
