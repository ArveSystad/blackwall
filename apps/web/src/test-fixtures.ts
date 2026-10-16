import {
  backlogItemViewSchema,
  taskSchema,
  type BacklogItemView,
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
    status: "queued",
    stage: null,
    gate: null,
    error: null,
    triageMode: "intervene",
    agents: {},
    cli: "claude",
    agentClis: {},
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
    triageMode: "intervene",
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
