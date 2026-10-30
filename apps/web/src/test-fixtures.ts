import {
  backlogItemViewSchema,
  repoViewSchema,
  taskSchema,
  type BacklogItemView,
  type RepoView,
  type Task,
} from "@blackwall/shared";

let seq = 0;

/** A valid task for tests; ids are unique per call. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return taskSchema.parse({
    id: `t${seq}`,
    title: `Task ${seq}`,
    origin: { kind: "free-text" },
    mode: null,
    prBranch: null,
    repoId: "r1",
    branch: null,
    baseBranch: null,
    worktreePath: null,
    inRepo: false,
    status: "queued",
    stage: null,
    gate: null,
    error: null,
    triageMode: "intervene",
    agents: {},
    cli: "claude",
    agentClis: {},
    referenceRepoIds: [],
    deliveryTargets: [],
    delivering: false,
    freeText: "",
    plan: null,
    summary: null,
    shortSummary: null,
    squashMessage: null,
    followUps: [],
    archivedAt: null,
    ci: null,
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides,
  });
}

/** A valid backlog item as listed; ids are unique per call. */
export function makeBacklogItem(overrides: Partial<BacklogItemView> = {}): BacklogItemView {
  seq += 1;
  return backlogItemViewSchema.parse({
    id: `b${seq}`,
    repoId: "r1",
    title: `Item ${seq}`,
    origin: { kind: "free-text" },
    mode: null,
    freeText: "Do it",
    agents: {},
    agentClis: {},
    referenceRepoIds: null,
    triageMode: "intervene",
    inRepo: false,
    position: seq,
    dependsOn: [],
    status: "waiting",
    taskId: null,
    sourceTaskId: null,
    blocked: false,
    blockedBy: [],
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides,
  });
}

/** A valid listed repo for tests: `app` at `C:\Code\app` with a GitHub origin. */
export function makeRepo(overrides: Partial<RepoView> = {}): RepoView {
  return repoViewSchema.parse({
    id: "r1",
    path: "C:\\Code\\app",
    name: "app",
    remoteUrl: "git@github.com:acme/app.git",
    remoteKey: "github.com/acme/app",
    connectionId: "c1",
    checkCommands: [],
    setupCommands: [],
    runCommands: [],
    defaultCli: "claude",
    defaultOrigin: "free-text",
    maxBacklogTasks: null,
    defaultBranch: "main",
    favorite: false,
    position: 0,
    watchCi: false,
    defaultInRepo: false,
    jiraProject: null,
    referenceRepoIds: [],
    agentTrust: "locked",
    trustProjectMcp: false,
    trustProjectHooks: false,
    exists: true,
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides,
  });
}
