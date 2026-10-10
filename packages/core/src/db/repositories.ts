import { and, asc, desc, eq, gt, isNotNull, max, sql } from "drizzle-orm";
import type {
  ActiveAgentStep,
  Agent,
  BacklogItem,
  Connection,
  Finding,
  FindingStatus,
  GrillAnswerer,
  GrillQuestion,
  Repo,
  Run,
  Step,
  StepEvent,
  StepStatus,
  Tag,
  Task,
  TaskDoneTime,
} from "@blackwall/shared";
import type { Db } from "./database.js";
import {
  agents,
  backlogItems,
  connections,
  findings,
  grillQuestions,
  repos,
  runs,
  settings,
  stepEvents,
  steps,
  tags,
  tasks,
  type NewAgent,
  type NewBacklogItem,
  type NewConnection,
  type NewFinding,
  type NewGrillQuestion,
  type NewRepo,
  type NewStep,
  type NewTask,
} from "./schema.js";

/** Updatable columns of an insert type. */
type Patch<T> = Partial<Omit<T, "id" | "createdAt" | "updatedAt">>;

/** Insertion order; breaks ties between rows created in the same millisecond. */
const rowid = sql`rowid`;

function required<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new Error(`${what} not found`);
  return row;
}

export function createSettingsRepository(db: Db) {
  return {
    get<T = unknown>(key: string): T | undefined {
      return db.select().from(settings).where(eq(settings.key, key)).get()?.value as T | undefined;
    },
    set(key: string, value: unknown): void {
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } })
        .run();
    },
    delete(key: string): void {
      db.delete(settings).where(eq(settings.key, key)).run();
    },
    all(): Record<string, unknown> {
      return Object.fromEntries(
        db
          .select()
          .from(settings)
          .all()
          .map((s) => [s.key, s.value]),
      );
    },
  };
}

export function createConnectionsRepository(db: Db) {
  return {
    list(): Connection[] {
      return db.select().from(connections).orderBy(asc(connections.name)).all();
    },
    get(id: string): Connection | undefined {
      return db.select().from(connections).where(eq(connections.id, id)).get();
    },
    create(values: NewConnection): Connection {
      return db.insert(connections).values(values).returning().get();
    },
    update(id: string, patch: Patch<NewConnection>): Connection {
      return required(
        db.update(connections).set(patch).where(eq(connections.id, id)).returning().get(),
        `Connection ${id}`,
      );
    },
    delete(id: string): void {
      db.delete(connections).where(eq(connections.id, id)).run();
    },
  };
}

export function createReposRepository(db: Db) {
  return {
    /** Favourites first, then the manual order; the name breaks ties. */
    list(): Repo[] {
      return db
        .select()
        .from(repos)
        .orderBy(desc(repos.favorite), asc(repos.position), asc(repos.name))
        .all();
    },
    get(id: string): Repo | undefined {
      return db.select().from(repos).where(eq(repos.id, id)).get();
    },
    getByPath(path: string): Repo | undefined {
      return db.select().from(repos).where(eq(repos.path, path)).get();
    },
    /** Adds a repo at the end of the manual order unless a position is given. */
    create(values: NewRepo): Repo {
      return db.transaction((tx) => {
        let position = values.position;
        if (position === undefined) {
          const last = tx
            .select({ p: max(repos.position) })
            .from(repos)
            .get();
          position = last?.p == null ? 0 : last.p + 1;
        }
        return tx
          .insert(repos)
          .values({ ...values, position })
          .returning()
          .get();
      });
    },
    update(id: string, patch: Patch<NewRepo>): Repo {
      return required(
        db.update(repos).set(patch).where(eq(repos.id, id)).returning().get(),
        `Repo ${id}`,
      );
    },
    /** Sets the manual order: each listed repo gets its index as position. */
    reorder(orderedIds: readonly string[]): void {
      db.transaction((tx) => {
        orderedIds.forEach((id, position) => {
          tx.update(repos).set({ position }).where(eq(repos.id, id)).run();
        });
      });
    },
    /** Whether any task references the repo; such a repo cannot be deleted. */
    hasTasks(id: string): boolean {
      return (
        db.select({ id: tasks.id }).from(tasks).where(eq(tasks.repoId, id)).limit(1).get() !==
        undefined
      );
    },
    delete(id: string): void {
      db.delete(repos).where(eq(repos.id, id)).run();
    },
  };
}

export function createAgentsRepository(db: Db) {
  return {
    list(): Agent[] {
      return db.select().from(agents).orderBy(asc(agents.name)).all();
    },
    get(id: string): Agent | undefined {
      return db.select().from(agents).where(eq(agents.id, id)).get();
    },
    create(values: NewAgent): Agent {
      return db.insert(agents).values(values).returning().get();
    },
    update(id: string, patch: Patch<NewAgent>): Agent {
      return required(
        db.update(agents).set(patch).where(eq(agents.id, id)).returning().get(),
        `Agent ${id}`,
      );
    },
    delete(id: string): void {
      db.delete(agents).where(eq(agents.id, id)).run();
    },
  };
}

export function createTagsRepository(db: Db) {
  return {
    list(): Tag[] {
      return db.select().from(tags).orderBy(asc(tags.position), asc(tags.name)).all();
    },
    names(): string[] {
      return this.list().map((t) => t.name);
    },
    /** Replaces the whole tag list, keeping the given order. */
    replace(names: readonly string[]): void {
      db.transaction((tx) => {
        tx.delete(tags).run();
        if (names.length > 0) {
          tx.insert(tags)
            .values(names.map((name, position) => ({ name, position })))
            .run();
        }
      });
    },
  };
}

export function createTasksRepository(db: Db) {
  return {
    list(): Task[] {
      return db.select().from(tasks).orderBy(asc(tasks.createdAt), asc(rowid)).all();
    },
    get(id: string): Task | undefined {
      return db.select().from(tasks).where(eq(tasks.id, id)).get();
    },
    create(values: NewTask): Task {
      return db.insert(tasks).values(values).returning().get();
    },
    update(id: string, patch: Patch<NewTask>): Task {
      return required(
        db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get(),
        `Task ${id}`,
      );
    },
    delete(id: string): void {
      db.delete(tasks).where(eq(tasks.id, id)).run();
    },
  };
}

/** Backlog item fields the user can edit; promotion goes through `markPromoted`. */
export type BacklogItemPatch = {
  [K in "title" | "freeText" | "priority" | "dependsOn" | "status" | "agents" | "triageMode"]?:
    BacklogItem[K] | undefined;
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Inserts an item at the end of its repo's manual order unless a position is given. */
function insertAtEnd(tx: Tx, values: NewBacklogItem): BacklogItem {
  let position = values.position;
  if (position === undefined) {
    const last = tx
      .select({ p: max(backlogItems.position) })
      .from(backlogItems)
      .where(eq(backlogItems.repoId, values.repoId))
      .get();
    position = last?.p == null ? 0 : last.p + 1;
  }
  return tx
    .insert(backlogItems)
    .values({ ...values, position })
    .returning()
    .get();
}

export function createBacklogItemsRepository(db: Db) {
  return {
    /** Items of one repo (or all), in insertion order; pick order is `sortBacklog`'s job. */
    list(repoId?: string): BacklogItem[] {
      const query = db.select().from(backlogItems);
      return (repoId === undefined ? query : query.where(eq(backlogItems.repoId, repoId)))
        .orderBy(asc(backlogItems.createdAt), asc(rowid))
        .all();
    },
    get(id: string): BacklogItem | undefined {
      return db.select().from(backlogItems).where(eq(backlogItems.id, id)).get();
    },
    /** Adds an item at the end of the repo's manual order unless a position is given. */
    insert(values: NewBacklogItem): BacklogItem {
      return db.transaction((tx) => insertAtEnd(tx, values));
    },
    /** Adds several items, each as {@link insert} would, all or none. */
    insertMany(values: readonly NewBacklogItem[]): BacklogItem[] {
      return db.transaction((tx) => values.map((v) => insertAtEnd(tx, v)));
    },
    update(id: string, patch: BacklogItemPatch): BacklogItem {
      return required(
        db.update(backlogItems).set(patch).where(eq(backlogItems.id, id)).returning().get(),
        `Backlog item ${id}`,
      );
    },
    delete(id: string): void {
      db.delete(backlogItems).where(eq(backlogItems.id, id)).run();
    },
    /** Sets the manual order: each listed item of the repo gets its index as position. */
    reorder(repoId: string, orderedIds: readonly string[]): void {
      db.transaction((tx) => {
        orderedIds.forEach((id, position) => {
          tx.update(backlogItems)
            .set({ position })
            .where(and(eq(backlogItems.id, id), eq(backlogItems.repoId, repoId)))
            .run();
        });
      });
    },
    markPromoted(id: string, taskId: string): BacklogItem {
      return required(
        db
          .update(backlogItems)
          .set({ status: "promoted", taskId })
          .where(eq(backlogItems.id, id))
          .returning()
          .get(),
        `Backlog item ${id}`,
      );
    },
  };
}

export function createRunsRepository(db: Db) {
  return {
    listByTask(taskId: string): Run[] {
      return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.number)).all();
    },
    get(id: string): Run | undefined {
      return db.select().from(runs).where(eq(runs.id, id)).get();
    },
    /** Starts the next run for a task, numbered after the previous one. */
    create(taskId: string): Run {
      return db.transaction((tx) => {
        const last = tx
          .select({ n: max(runs.number) })
          .from(runs)
          .where(eq(runs.taskId, taskId))
          .get();
        return tx
          .insert(runs)
          .values({ taskId, number: (last?.n ?? 0) + 1 })
          .returning()
          .get();
      });
    },
    setStatus(id: string, status: StepStatus, finishedAt: Date | null = null): Run {
      return required(
        db.update(runs).set({ status, finishedAt }).where(eq(runs.id, id)).returning().get(),
        `Run ${id}`,
      );
    },
    /**
     * The latest finish time of each task's succeeded runs. Delivery is the
     * only path to `done`, and it marks the run succeeded, so this is when
     * the task was resolved. Tasks without a succeeded run are left out.
     */
    doneTimes(): TaskDoneTime[] {
      return (
        db
          .select({ taskId: runs.taskId, doneAt: max(runs.finishedAt) })
          .from(runs)
          .where(and(eq(runs.status, "succeeded"), isNotNull(runs.finishedAt)))
          .groupBy(runs.taskId)
          .all()
          // `max()` hands back the raw stored milliseconds, not a Date.
          .flatMap(({ taskId, doneAt }) =>
            doneAt == null ? [] : [{ taskId, doneAt: new Date(doneAt) }],
          )
      );
    },
  };
}

export function createStepsRepository(db: Db) {
  return {
    listByRun(runId: string): Step[] {
      return db
        .select()
        .from(steps)
        .where(eq(steps.runId, runId))
        .orderBy(asc(steps.createdAt), asc(rowid))
        .all();
    },
    /** Running agent steps (harness steps left out) with their task, oldest first. */
    listActiveAgents(): ActiveAgentStep[] {
      return (
        db
          .select({ step: steps, taskId: runs.taskId })
          .from(steps)
          .innerJoin(runs, eq(steps.runId, runs.id))
          .where(and(eq(steps.status, "running"), isNotNull(steps.agentId)))
          // The bare `rowid` is ambiguous in a join, so it is qualified here.
          .orderBy(asc(steps.createdAt), asc(sql`${steps}.rowid`))
          .all()
          .map(({ step, taskId }) => ({ ...step, taskId }))
      );
    },
    get(id: string): Step | undefined {
      return db.select().from(steps).where(eq(steps.id, id)).get();
    },
    create(values: NewStep): Step {
      return db.insert(steps).values(values).returning().get();
    },
    update(id: string, patch: Patch<NewStep>): Step {
      return required(
        db.update(steps).set(patch).where(eq(steps.id, id)).returning().get(),
        `Step ${id}`,
      );
    },
    /** Marks steps left running by a previous process as interrupted; returns them. */
    interruptRunning(): Step[] {
      return db
        .update(steps)
        .set({ status: "interrupted" })
        .where(eq(steps.status, "running"))
        .returning()
        .all();
    },
  };
}

export function createStepEventsRepository(db: Db) {
  return {
    /** Appends an event with the next sequence number for the step. Events are never updated. */
    append(stepId: string, type: string, payload: unknown): StepEvent {
      return db.transaction((tx) => {
        const last = tx
          .select({ seq: max(stepEvents.seq) })
          .from(stepEvents)
          .where(eq(stepEvents.stepId, stepId))
          .get();
        return tx
          .insert(stepEvents)
          .values({ stepId, seq: (last?.seq ?? 0) + 1, type, payload })
          .returning()
          .get();
      });
    },
    /** Events for a step in order, optionally only those after `afterSeq`. */
    list(stepId: string, afterSeq = 0): StepEvent[] {
      return db
        .select()
        .from(stepEvents)
        .where(and(eq(stepEvents.stepId, stepId), gt(stepEvents.seq, afterSeq)))
        .orderBy(asc(stepEvents.seq))
        .all();
    },
  };
}

/** Finding fields the harness may rewrite after creation. */
export type FindingPatch = Partial<
  Pick<
    Finding,
    | "severity"
    | "tags"
    | "file"
    | "lineStart"
    | "lineEnd"
    | "explanation"
    | "suggestedFix"
    | "status"
    | "mergedIntoId"
  >
>;

export function createFindingsRepository(db: Db) {
  return {
    listByTask(taskId: string): Finding[] {
      return db
        .select()
        .from(findings)
        .where(eq(findings.taskId, taskId))
        .orderBy(asc(findings.createdAt), asc(rowid))
        .all();
    },
    get(id: string): Finding | undefined {
      return db.select().from(findings).where(eq(findings.id, id)).get();
    },
    createMany(values: readonly NewFinding[]): Finding[] {
      if (values.length === 0) return [];
      return db
        .insert(findings)
        .values([...values])
        .returning()
        .all();
    },
    setStatus(id: string, status: FindingStatus): Finding {
      return required(
        db.update(findings).set({ status }).where(eq(findings.id, id)).returning().get(),
        `Finding ${id}`,
      );
    },
    /** Rewrites a finding, e.g. when the aggregation step merges duplicates into it. */
    update(id: string, patch: FindingPatch): Finding {
      return required(
        db.update(findings).set(patch).where(eq(findings.id, id)).returning().get(),
        `Finding ${id}`,
      );
    },
  };
}

export function createGrillQuestionsRepository(db: Db) {
  return {
    listByTask(taskId: string): GrillQuestion[] {
      return db
        .select()
        .from(grillQuestions)
        .where(eq(grillQuestions.taskId, taskId))
        .orderBy(asc(grillQuestions.createdAt), asc(rowid))
        .all();
    },
    get(id: string): GrillQuestion | undefined {
      return db.select().from(grillQuestions).where(eq(grillQuestions.id, id)).get();
    },
    create(values: NewGrillQuestion): GrillQuestion {
      return db.insert(grillQuestions).values(values).returning().get();
    },
    /** The planner could not answer it from the repo: hand it to the user. */
    markNeedsHuman(id: string): GrillQuestion {
      return required(
        db
          .update(grillQuestions)
          .set({ needsHuman: true })
          .where(eq(grillQuestions.id, id))
          .returning()
          .get(),
        `Grill question ${id}`,
      );
    },
    answer(id: string, answer: string, answeredBy: GrillAnswerer): GrillQuestion {
      return required(
        db
          .update(grillQuestions)
          .set({ answer, answeredBy, answeredAt: new Date() })
          .where(eq(grillQuestions.id, id))
          .returning()
          .get(),
        `Grill question ${id}`,
      );
    },
  };
}

export function createRepositories(db: Db) {
  return {
    settings: createSettingsRepository(db),
    connections: createConnectionsRepository(db),
    repos: createReposRepository(db),
    agents: createAgentsRepository(db),
    tags: createTagsRepository(db),
    tasks: createTasksRepository(db),
    backlogItems: createBacklogItemsRepository(db),
    runs: createRunsRepository(db),
    steps: createStepsRepository(db),
    stepEvents: createStepEventsRepository(db),
    findings: createFindingsRepository(db),
    grillQuestions: createGrillQuestionsRepository(db),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
