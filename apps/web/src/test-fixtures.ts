import { taskSchema, type Task } from "@blackwall/shared";

let seq = 0;

/** A valid task for tests; ids are unique per call. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  seq += 1;
  return taskSchema.parse({
    id: `t${seq}`,
    title: `Task ${seq}`,
    origin: { kind: "free-text" },
    mode: null,
    repoId: "r1",
    branch: null,
    worktreePath: null,
    status: "queued",
    stage: null,
    gate: null,
    error: null,
    triageMode: "intervene",
    agents: {},
    deliveryTargets: [],
    freeText: "",
    plan: null,
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    ...overrides,
  });
}
