import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import type {
  ActiveAgentStep,
  ActiveSubagent,
  Agent,
  AgentCli,
  BacklogItem,
  ChatAction,
  ChatMessage,
  Connection,
  Finding,
  FindingStatus,
  GrillAnswerer,
  GrillQuestion,
  Memory,
  MemoryInput,
  PrBranch,
  Repo,
  Run,
  Step,
  StepEvent,
  StepStatus,
  StepUsage,
  Tag,
  Task,
  TaskDoneTime,
} from "@blackwall/shared";
import { remoteKey } from "@blackwall/shared";
import type { Db } from "./database.js";
import {
  agents,
  backlogItems,
  chatMessages,
  connections,
  findings,
  grillQuestions,
  memories,
  repos,
  runs,
  settings,
  stepEvents,
  steps,
  tags,
  tasks,
  type NewAgent,
  type NewBacklogItem,
  type NewChatMessage,
  type NewConnection,
  type NewFinding,
  type NewGrillQuestion,
  type NewMemory,
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
          .values({ ...values, position, remoteKey: remoteKey(values.remoteUrl ?? null) })
          .returning()
          .get();
      });
    },
    /** A patch with `remoteUrl` also sets `remoteKey`. */
    update(id: string, patch: Patch<NewRepo>): Repo {
      const values =
        patch.remoteUrl === undefined ? patch : { ...patch, remoteKey: remoteKey(patch.remoteUrl) };
      return required(
        db.update(repos).set(values).where(eq(repos.id, id)).returning().get(),
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
    /** Moves the steps, findings and grill questions of agent `fromId` over to `toId`. */
    reassign(fromId: string, toId: string): void {
      db.transaction((tx) => {
        tx.update(steps).set({ agentId: toId }).where(eq(steps.agentId, fromId)).run();
        tx.update(findings)
          .set({ reviewerAgentId: toId })
          .where(eq(findings.reviewerAgentId, fromId))
          .run();
        tx.update(grillQuestions)
          .set({ askedByAgentId: toId })
          .where(eq(grillQuestions.askedByAgentId, fromId))
          .run();
      });
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
    /** PR tasks start with their head branch `unchecked`; other origins have no PR branch state. */
    create(values: NewTask): Task {
      const prBranch: PrBranch | null = values.origin.kind === "github-pr" ? "unchecked" : null;
      return db
        .insert(tasks)
        .values({ ...values, prBranch })
        .returning()
        .get();
    },
    update(id: string, patch: Patch<NewTask>): Task {
      return required(
        db.update(tasks).set(patch).where(eq(tasks.id, id)).returning().get(),
        `Task ${id}`,
      );
    },
    setPrBranch(id: string, state: PrBranch): Task {
      return required(
        db.update(tasks).set({ prBranch: state }).where(eq(tasks.id, id)).returning().get(),
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
  [
    K in
      | "title"
      | "freeText"
      | "dependsOn"
      | "status"
      | "agents"
      | "agentClis"
      | "referenceRepoIds"
      | "triageMode"
      | "inRepo"
  ]?: BacklogItem[K] | undefined;
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

function toChatMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    actions: row.actions,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One conversation's rows: the repo's chat when `taskId` is null, else that task's. */
function chatScope(repoId: string, taskId: string | null) {
  return and(
    eq(chatMessages.repoId, repoId),
    taskId === null ? isNull(chatMessages.taskId) : eq(chatMessages.taskId, taskId),
  );
}

export function createChatMessagesRepository(db: Db) {
  return {
    /** A conversation, oldest first: the repo's chat when `taskId` is null, else that task's. */
    list(repoId: string, taskId: string | null): ChatMessage[] {
      return db
        .select()
        .from(chatMessages)
        .where(chatScope(repoId, taskId))
        .orderBy(asc(chatMessages.createdAt), asc(rowid))
        .all()
        .map(toChatMessage);
    },
    /** The CLI session of the conversation's newest assistant turn that recorded one. */
    latestSession(
      repoId: string,
      taskId: string | null,
    ): { sessionId: string; cli: AgentCli } | undefined {
      const row = db
        .select({ sessionId: chatMessages.sessionId, cli: chatMessages.cli })
        .from(chatMessages)
        .where(
          and(
            chatScope(repoId, taskId),
            isNotNull(chatMessages.sessionId),
            isNotNull(chatMessages.cli),
          ),
        )
        .orderBy(desc(chatMessages.createdAt), desc(rowid))
        .limit(1)
        .get();
      return row?.sessionId && row.cli ? { sessionId: row.sessionId, cli: row.cli } : undefined;
    },
    insert(values: NewChatMessage): ChatMessage {
      return toChatMessage(db.insert(chatMessages).values(values).returning().get());
    },
    setActions(id: string, actions: ChatAction[]): void {
      db.update(chatMessages).set({ actions }).where(eq(chatMessages.id, id)).run();
    },
    deleteConversation(repoId: string, taskId: string | null): void {
      db.delete(chatMessages).where(chatScope(repoId, taskId)).run();
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
    /**
     * Running agent steps with their open sub-agents: started and not yet
     * ended, counting only events of the current attempt (a resumed step
     * keeps its id, and a killed attempt's sub-agents never end).
     */
    listActiveAgents(): ActiveAgentStep[] {
      const running = db
        .select({ step: steps, taskId: runs.taskId })
        .from(steps)
        .innerJoin(runs, eq(steps.runId, runs.id))
        .where(and(eq(steps.status, "running"), isNotNull(steps.agentId)))
        // The bare `rowid` is ambiguous in a join, so it is qualified here.
        .orderBy(asc(steps.createdAt), asc(sql`${steps}.rowid`))
        .all();
      if (running.length === 0) return [];
      const events = db
        .select()
        .from(stepEvents)
        .where(
          and(
            inArray(
              stepEvents.stepId,
              running.map(({ step }) => step.id),
            ),
            inArray(stepEvents.type, ["subagent-start", "subagent-end"]),
          ),
        )
        .orderBy(asc(stepEvents.stepId), asc(stepEvents.seq))
        .all();
      return running.map(({ step, taskId }) => {
        const open = new Map<string, ActiveSubagent>();
        for (const event of events) {
          if (event.stepId !== step.id) continue;
          if (step.startedAt && event.createdAt < step.startedAt) continue;
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (typeof payload.id !== "string") continue;
          if (event.type === "subagent-end") {
            open.delete(payload.id);
          } else {
            open.set(payload.id, {
              id: payload.id,
              agentType: typeof payload.agentType === "string" ? payload.agentType : "unknown",
              description: typeof payload.description === "string" ? payload.description : null,
              startedAt: event.createdAt,
            });
          }
        }
        return { ...step, taskId, subagents: [...open.values()] };
      });
    },
    /**
     * Usage of every agent step that used tokens or reported a cost, with its
     * task, oldest first: the task header and stats view add these up.
     */
    usage(): StepUsage[] {
      return db
        .select({ step: steps, taskId: runs.taskId })
        .from(steps)
        .innerJoin(runs, eq(steps.runId, runs.id))
        .where(
          and(
            isNotNull(steps.agentId),
            or(
              gt(steps.inputTokens, 0),
              gt(steps.outputTokens, 0),
              gt(steps.cacheReadTokens, 0),
              gt(steps.cacheWriteTokens, 0),
              isNotNull(steps.costUsd),
            ),
          ),
        )
        .orderBy(asc(steps.createdAt), asc(sql`${steps}.rowid`))
        .all()
        .map(({ step, taskId }) => ({
          taskId,
          stepId: step.id,
          at: step.startedAt ?? step.createdAt,
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          cacheReadTokens: step.cacheReadTokens,
          cacheWriteTokens: step.cacheWriteTokens,
          costUsd: step.costUsd,
        }));
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
    /** The step's last event of `type`, if it logged one. */
    lastOfType(stepId: string, type: string): StepEvent | undefined {
      return db
        .select()
        .from(stepEvents)
        .where(and(eq(stepEvents.stepId, stepId), eq(stepEvents.type, type)))
        .orderBy(desc(stepEvents.seq))
        .limit(1)
        .get();
    },
    /** Events of any of `types` across the steps, ordered by step id, then sequence. */
    listOfTypes(stepIds: readonly string[], types: readonly string[]): StepEvent[] {
      if (stepIds.length === 0 || types.length === 0) return [];
      return db
        .select()
        .from(stepEvents)
        .where(and(inArray(stepEvents.stepId, stepIds), inArray(stepEvents.type, types)))
        .orderBy(asc(stepEvents.stepId), asc(stepEvents.seq))
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
    /**
     * Deletes a finding and the duplicates merged into it, returning their
     * ids. Duplicates go first, so their `mergedIntoId` never falls back to null.
     */
    deleteWithMerged(id: string): string[] {
      return db.transaction((tx) => {
        const merged = tx
          .delete(findings)
          .where(eq(findings.mergedIntoId, id))
          .returning({ id: findings.id })
          .all();
        const deleted = tx
          .delete(findings)
          .where(eq(findings.id, id))
          .returning({ id: findings.id })
          .all();
        return [...merged, ...deleted].map((f) => f.id);
      });
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

/** Memory fields that can change after creation. */
export type MemoryPatch = Partial<Pick<NewMemory, "kind" | "text" | "files" | "pinned">>;

/** Most search terms taken from the text `relevant` matches on. */
const MAX_MEMORY_TERMS = 32;

/** How two notes are compared for duplicates. */
const normalise = (text: string) => text.trim().toLowerCase();

/**
 * An FTS5 query matching any word of `text` of at least 3 characters, each
 * quoted as a phrase so FTS syntax in it is never interpreted; empty when none.
 */
function memoryQuery(text: string): string {
  const terms = [...new Set(text.split(/\s+/).filter((t) => t.length >= 3))];
  return terms
    .slice(0, MAX_MEMORY_TERMS)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" OR ");
}

export function createMemoriesRepository(db: Db) {
  /** Normalised texts of the repo's active (not held) notes. */
  const activeTexts = (tx: Tx, repoId: string) =>
    new Set(
      tx
        .select({ text: memories.text })
        .from(memories)
        .where(and(eq(memories.repoId, repoId), eq(memories.awaitingMerge, false)))
        .all()
        .map((m) => normalise(m.text)),
    );

  return {
    get(id: string): Memory | undefined {
      return db.select().from(memories).where(eq(memories.id, id)).get();
    },
    create(values: NewMemory): Memory {
      return db.insert(memories).values(values).returning().get();
    },
    /** Edits a note; `byUser` marks it edited, so Summarize never replaces it. */
    update(id: string, patch: MemoryPatch, { byUser = false }: { byUser?: boolean } = {}): Memory {
      return required(
        db
          .update(memories)
          .set(byUser ? { ...patch, editedAt: new Date() } : patch)
          .where(eq(memories.id, id))
          .returning()
          .get(),
        `Memory ${id}`,
      );
    },
    delete(id: string): void {
      db.delete(memories).where(eq(memories.id, id)).run();
    },
    /** The repo's active notes (held ones left out): pinned first, then newest. */
    listByRepo(repoId: string): Memory[] {
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.repoId, repoId), eq(memories.awaitingMerge, false)))
        .orderBy(desc(memories.pinned), desc(memories.createdAt), desc(rowid))
        .all();
    },
    /** The repo's held notes, waiting for their pull request to merge: newest first. */
    listAwaitingByRepo(repoId: string): Memory[] {
      return db
        .select()
        .from(memories)
        .where(and(eq(memories.repoId, repoId), eq(memories.awaitingMerge, true)))
        .orderBy(desc(memories.createdAt), desc(rowid))
        .all();
    },
    /**
     * Replaces the task's notes the user never edited (held or not) with
     * `items`, skipping any whose text an active note in the repo or an
     * earlier item already has. Returns the inserted notes.
     */
    replaceForTask(
      taskId: string,
      repoId: string,
      items: readonly MemoryInput[],
      { awaitingMerge = false }: { awaitingMerge?: boolean } = {},
    ): Memory[] {
      return db.transaction((tx) => {
        tx.delete(memories)
          .where(and(eq(memories.sourceTaskId, taskId), isNull(memories.editedAt)))
          .run();
        const seen = activeTexts(tx, repoId);
        const inserted: Memory[] = [];
        for (const item of items) {
          const key = normalise(item.text);
          if (seen.has(key)) continue;
          seen.add(key);
          inserted.push(
            tx
              .insert(memories)
              .values({
                repoId,
                sourceTaskId: taskId,
                kind: item.kind,
                text: item.text,
                files: item.files ?? null,
                awaitingMerge,
              })
              .returning()
              .get(),
          );
        }
        return inserted;
      });
    },
    /** Tasks with notes held until their pull request merges. */
    tasksAwaitingMerge(): string[] {
      return db
        .selectDistinct({ taskId: memories.sourceTaskId })
        .from(memories)
        .where(and(eq(memories.awaitingMerge, true), isNotNull(memories.sourceTaskId)))
        .all()
        .flatMap((m) => (m.taskId === null ? [] : [m.taskId]));
    },
    /** The repo's tasks with at least one note, held or active. */
    taskIdsWithNotes(repoId: string): Set<string> {
      return new Set(
        db
          .selectDistinct({ taskId: memories.sourceTaskId })
          .from(memories)
          .where(and(eq(memories.repoId, repoId), isNotNull(memories.sourceTaskId)))
          .all()
          .flatMap((m) => (m.taskId === null ? [] : [m.taskId])),
      );
    },
    /**
     * Makes the task's held notes active, dropping any whose text an active
     * note in the repo now has. Returns the released notes.
     */
    releaseForTask(taskId: string): Memory[] {
      return db.transaction((tx) => {
        const held = tx
          .select()
          .from(memories)
          .where(and(eq(memories.sourceTaskId, taskId), eq(memories.awaitingMerge, true)))
          .orderBy(asc(memories.createdAt), asc(rowid))
          .all();
        const seen = new Map<string, Set<string>>();
        const released: Memory[] = [];
        for (const note of held) {
          let texts = seen.get(note.repoId);
          if (!texts) seen.set(note.repoId, (texts = activeTexts(tx, note.repoId)));
          const key = normalise(note.text);
          if (texts.has(key)) {
            tx.delete(memories).where(eq(memories.id, note.id)).run();
            continue;
          }
          texts.add(key);
          released.push(
            required(
              tx
                .update(memories)
                .set({ awaitingMerge: false })
                .where(eq(memories.id, note.id))
                .returning()
                .get(),
              `Memory ${note.id}`,
            ),
          );
        }
        return released;
      });
    },
    /**
     * Deletes the task's held notes; with null, the held notes whose task was
     * deleted, which can never be released. Returns the distinct repo ids of
     * the deleted notes (empty when nothing was held).
     */
    discardAwaiting(taskId: string | null): string[] {
      const deleted = db
        .delete(memories)
        .where(
          and(
            eq(memories.awaitingMerge, true),
            taskId === null ? isNull(memories.sourceTaskId) : eq(memories.sourceTaskId, taskId),
          ),
        )
        .returning({ repoId: memories.repoId })
        .all();
      return [...new Set(deleted.map((row) => row.repoId))];
    },
    /**
     * The repo's active notes most relevant to `text`: every pinned note
     * (matching ones first), then the best full-text matches, at most `limit`.
     * `excludeTaskId` leaves out that task's notes the user never edited.
     */
    relevant(
      repoId: string,
      text: string,
      {
        limit = 8,
        excludeTaskId,
      }: { limit?: number | undefined; excludeTaskId?: string | undefined } = {},
    ): Memory[] {
      // `IS NOT`, so notes whose task was deleted (null) are kept.
      const notOwn =
        excludeTaskId === undefined
          ? sql`1`
          : sql`(${memories.sourceTaskId} IS NOT ${excludeTaskId} OR ${memories.editedAt} IS NOT NULL)`;
      const pinned = db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.repoId, repoId),
            eq(memories.awaitingMerge, false),
            eq(memories.pinned, true),
            notOwn,
          ),
        )
        .orderBy(desc(memories.createdAt), desc(rowid))
        .all();
      const query = memoryQuery(text);
      if (!query) return pinned.slice(0, limit);
      let ids: string[];
      try {
        ids = db
          .all<{ id: string }>(
            sql`SELECT memories.id AS id FROM memories_fts
              JOIN memories ON memories.rowid = memories_fts.rowid
              WHERE memories_fts MATCH ${query} AND memories.repo_id = ${repoId}
                AND memories.awaiting_merge = 0 AND ${notOwn}
              ORDER BY bm25(memories_fts) LIMIT ${limit + pinned.length}`,
          )
          .map((m) => m.id);
      } catch {
        return pinned.slice(0, limit);
      }
      const rank = new Map(ids.map((id, i) => [id, i]));
      const byRank = (a: Memory, b: Memory) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
      const matches =
        ids.length === 0
          ? []
          : db.select().from(memories).where(inArray(memories.id, ids)).all().sort(byRank);
      return [
        ...pinned.filter((m) => rank.has(m.id)).sort(byRank),
        ...pinned.filter((m) => !rank.has(m.id)),
        ...matches.filter((m) => !m.pinned),
      ].slice(0, limit);
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
    chatMessages: createChatMessagesRepository(db),
    runs: createRunsRepository(db),
    steps: createStepsRepository(db),
    stepEvents: createStepEventsRepository(db),
    findings: createFindingsRepository(db),
    grillQuestions: createGrillQuestionsRepository(db),
    memories: createMemoriesRepository(db),
    /** Runs `fn` in one transaction; repository calls inside it nest as savepoints. */
    transaction<T>(fn: () => T): T {
      return db.transaction(() => fn());
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
