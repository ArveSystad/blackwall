import {
  agentCliFor,
  memoryBackfillOutputJsonSchema,
  parseMemories,
  ROLE_STAGES,
  type AgentCli,
  type GrillQuestion,
  type Memory,
  type MemoryBackfillStatus,
  type Repo,
  type Task,
} from "@blackwall/shared";
import { z } from "zod";
import type { AgentAdapter, AgentResult } from "../agents/adapters/types.js";
import { permissionsFor } from "../agents/permissions.js";
import { memoriesPromptSection } from "../agents/prompts.js";
import type { AgentService } from "../agents/service.js";
import type { Repositories } from "../db/repositories.js";
import type { RepoRenameLocks } from "../repos/rename-lock.js";
import { RepoNotFoundError } from "../repos/service.js";
import { memoryBackfillKey } from "../settings/service.js";
import { TaskStateError } from "./engine.js";
import type { PullRequestMergeState } from "./memory-release.js";
import { describeQuestion, memoryInstructions, section } from "./stages.js";

/** A backfill started while one already runs in the repo. Maps to 409 like a task state conflict. */
export class MemoryBackfillBusyError extends TaskStateError {
  constructor() {
    super("Blackwall is already learning from this repo's past tasks");
    this.name = "MemoryBackfillBusyError";
  }
}

export interface MemoryBackfillOptions {
  repositories: Pick<Repositories, "tasks" | "repos" | "memories" | "grillQuestions" | "settings">;
  adapters: Partial<Record<AgentCli, AgentAdapter>>;
  agents: Pick<AgentService, "resolveRoles" | "invocation">;
  /** The task's pull request as GitHub sees it; throws without a token or on network errors. */
  prMergeState: (task: Task, signal: AbortSignal) => Promise<PullRequestMergeState>;
  /** Called after a pass that saved held notes, so the releaser can settle them. */
  onHeld?: () => void;
  /** Called with the repo's id after a task's notes are saved, so its list can refresh. */
  onChanged?: (repoId: string) => void;
  /** Refuses a pass in a repo that is being renamed. */
  renaming?: Pick<RepoRenameLocks, "assertFree"> | undefined;
  log?: (message: string) => void;
}

export type MemoryBackfill = ReturnType<typeof createMemoryBackfill>;

const processedSchema = z.object({ taskIds: z.array(z.string()) });

/**
 * The repo's finished tasks a backfill reads, oldest first: done with a
 * summary, not a review of someone else's pull request, not processed by an
 * earlier pass and without notes (held or active). Archived ones count too.
 */
export function eligibleTasks(
  tasks: readonly Task[],
  repoId: string,
  processed: ReadonlySet<string>,
  withNotes: ReadonlySet<string>,
): Task[] {
  return tasks.filter(
    (t) =>
      t.repoId === repoId &&
      t.status === "done" &&
      !!t.summary?.trim() &&
      t.mode !== "review" &&
      !processed.has(t.id) &&
      !withNotes.has(t.id),
  );
}

function prompt(...parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

/**
 * The prompt that has the summarizer read a finished task again for lasting
 * notes about its repo: the task, its plan and summary, the answers the user
 * gave, the repo's notes on the subject, and Summarize's memory instructions
 * with a reminder that the code may have moved on (or, for a pull request not
 * merged yet, not arrived).
 */
export function memoryBackfillPrompt({
  task,
  questions,
  memories,
  defaultBranch,
}: {
  task: Task;
  questions: readonly GrillQuestion[];
  memories: readonly Memory[];
  defaultBranch: string;
}): string {
  const fromPr = task.origin.kind === "github-pr";
  const answers = questions.filter((q) => q.answeredBy === "user");
  return prompt(
    `# Task\n\n${task.title}`,
    section("Details", task.freeText),
    section("Plan", task.plan),
    section("Summary", task.summary),
    section("Answers the user gave", answers.map(describeQuestion).join("\n")),
    memoriesPromptSection(memories),
    [
      ...memoryInstructions({ fromPr, defaultBranch }),
      fromPr
        ? "This task's pull request may not be merged yet, so the checkout may not contain its changes. Check facts that don't come from this task against the current checkout. Take facts this task introduced from its plan and summary, and drop any the checkout contradicts outside this task's changes."
        : "This task finished earlier and the code may have moved on: check each fact against the current checkout and propose only those that still hold.",
      'Reply with a JSON object `{ "memories": [{ "kind": "convention", "text": "<one lasting fact>", "files": ["<path>"] }] }`.',
    ].join("\n"),
  );
}

interface Progress {
  running: boolean;
  done: number;
  saved: number;
  skipped: number;
  failed: number;
  /** Tasks this pass failed on; still eligible, but not left for this pass. */
  failedIds: Set<string>;
}

/** How one task went: `stop` ends the pass (usage limit or shutdown). */
type Outcome =
  | { kind: "saved"; notes: number; held: boolean }
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "stop" };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Fills a repo's memories from tasks that finished before memories existed, or
 * without saving any: started by hand, one pass per repo at a time. Each
 * eligible task (see {@link eligibleTasks}) gets one read-only summarizer run
 * in the repo's checkout, on the CLI the task ran its summarizer on (the
 * repo's default CLI when that one has no adapter), and its notes are saved
 * like Summarize's, held for pull request tasks. Every task is handled once,
 * tracked in the `memoryBackfill:<repoId>` setting: after a reply, when it
 * already has notes, or when its pull request was closed without merging into
 * the default branch. A failed run, a missing adapter or a failed pull request
 * lookup leaves it for the next pass; a usage limit stops the pass.
 */
export function createMemoryBackfill({
  repositories,
  adapters,
  agents,
  prMergeState,
  onHeld,
  onChanged = () => undefined,
  renaming,
  log = console.error,
}: MemoryBackfillOptions) {
  const { tasks, repos, memories, grillQuestions, settings } = repositories;
  const progress = new Map<string, Progress>();
  let lifetime = new AbortController();

  function repoOf(repoId: string): Repo {
    const repo = repos.get(repoId);
    if (!repo) throw new RepoNotFoundError(repoId);
    return repo;
  }

  function processedOf(repoId: string): Set<string> {
    const parsed = processedSchema.safeParse(settings.get(memoryBackfillKey(repoId)));
    return new Set(parsed.success ? parsed.data.taskIds : []);
  }

  function markProcessed(repoId: string, taskIds: readonly string[]): void {
    const processed = processedOf(repoId);
    for (const id of taskIds) processed.add(id);
    settings.set(memoryBackfillKey(repoId), { taskIds: [...processed] });
  }

  function eligible(repoId: string): Task[] {
    return eligibleTasks(
      tasks.list(),
      repoId,
      processedOf(repoId),
      memories.taskIdsWithNotes(repoId),
    );
  }

  /** The adapter, CLI, model and system prompt the task's summarizer runs on. */
  function summarizerFor(
    repo: Repo,
    task: Task,
  ): { adapter: AgentAdapter; cli: AgentCli; model?: string; systemPrompt?: string } | undefined {
    const summarizerId = task.agents.summarizer ?? agents.resolveRoles().summarizer;
    let cli = summarizerId ? agentCliFor(task, summarizerId) : repo.defaultCli;
    if (!adapters[cli]) cli = repo.defaultCli;
    const adapter = adapters[cli];
    if (!adapter) {
      log(`No adapter for the ${cli} CLI`);
      return undefined;
    }
    if (!summarizerId) return { adapter, cli };
    try {
      const inv = agents.invocation(summarizerId, ROLE_STAGES.summarizer, cli);
      return {
        adapter,
        cli,
        systemPrompt: inv.systemPrompt,
        ...(inv.model ? { model: inv.model } : {}),
      };
    } catch {
      // The agent was deleted or no longer fits the role: the CLI's defaults.
      return { adapter, cli };
    }
  }

  async function backfill(repo: Repo, task: Task, signal: AbortSignal): Promise<Outcome> {
    const fromPr = task.origin.kind === "github-pr";
    if (fromPr) {
      let pr: PullRequestMergeState;
      try {
        pr = await prMergeState(task, signal);
      } catch (error) {
        if (signal.aborted) return { kind: "stop" };
        log(`Memory backfill of task ${task.id} skipped: ${errorMessage(error)}`);
        return { kind: "failed" };
      }
      if (signal.aborted) return { kind: "stop" };
      const mergedHere = pr.merged && pr.baseRef === repo.defaultBranch;
      // The releaser would discard its notes anyway.
      if (!mergedHere && pr.state === "closed") {
        markProcessed(repo.id, [task.id]);
        return { kind: "skipped" };
      }
    }

    const summarizer = summarizerFor(repo, task);
    if (!summarizer) return { kind: "failed" };
    const { adapter, cli, model, systemPrompt } = summarizer;
    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimited = false;
    let result: AgentResult;
    try {
      const run = adapter.run({
        cwd: repo.path,
        prompt: memoryBackfillPrompt({
          task,
          questions: grillQuestions.listByTask(task.id),
          memories: memories.relevant(repo.id, `${task.title}\n${task.freeText}`, {
            excludeTaskId: task.id,
          }),
          defaultBranch: repo.defaultBranch,
        }),
        permissions: permissionsFor(cli, "read-only", {}, []),
        jsonSchema: memoryBackfillOutputJsonSchema(),
        signal,
        ...(model ? { model } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
      });
      for await (const event of run) {
        if (event.type === "rate-limit") rateLimited = true;
      }
      result = await run.result;
    } catch (error) {
      if (signal.aborted) return { kind: "stop" };
      if (rateLimited) {
        log(`Memory backfill stopped: the ${cli} CLI hit its usage limit`);
        return { kind: "stop" };
      }
      log(`Memory backfill of task ${task.id} failed: ${errorMessage(error)}`);
      return { kind: "failed" };
    }
    if (signal.aborted) return { kind: "stop" };
    const structured = result.structured as { memories?: unknown } | null | undefined;
    if (!Array.isArray(structured?.memories)) {
      log(`Memory backfill of task ${task.id} failed: the reply had no memories`);
      return { kind: "failed" };
    }
    const saved = memories.replaceForTask(task.id, repo.id, parseMemories(structured.memories), {
      awaitingMerge: fromPr,
    });
    onChanged(repo.id);
    markProcessed(repo.id, [task.id]);
    return { kind: "saved", notes: saved.length, held: fromPr && saved.length > 0 };
  }

  async function pass(repo: Repo, state: Progress, signal: AbortSignal): Promise<void> {
    // Tasks that already have notes (held ones too) are handled: never run them.
    const processed = processedOf(repo.id);
    const withNotes = memories.taskIdsWithNotes(repo.id);
    const handled = tasks
      .list()
      .filter(
        (t) =>
          t.repoId === repo.id &&
          t.status === "done" &&
          !processed.has(t.id) &&
          withNotes.has(t.id),
      );
    if (handled.length > 0)
      markProcessed(
        repo.id,
        handled.map((t) => t.id),
      );

    let held = false;
    try {
      for (const task of eligible(repo.id)) {
        if (signal.aborted) return;
        const outcome = await backfill(repo, task, signal);
        if (outcome.kind === "stop") return;
        state.done++;
        if (outcome.kind === "saved") {
          state.saved += outcome.notes;
          held ||= outcome.held;
        } else if (outcome.kind === "skipped") {
          state.skipped++;
        } else {
          state.failed++;
          state.failedIds.add(task.id);
        }
      }
    } finally {
      if (held && !signal.aborted) {
        try {
          onHeld?.();
        } catch (error) {
          log(`Memory release after the backfill failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  /**
   * Whether a pass runs, the counts of the current or last pass, and the
   * eligible tasks left: during a pass, those it has not reached yet.
   */
  function status(repoId: string): MemoryBackfillStatus {
    const repo = repoOf(repoId);
    const state = progress.get(repo.id);
    const left = eligible(repo.id).filter((t) => !(state?.running && state.failedIds.has(t.id)));
    return {
      running: state?.running ?? false,
      pending: left.length,
      done: state?.done ?? 0,
      saved: state?.saved ?? 0,
      skipped: state?.skipped ?? 0,
      failed: state?.failed ?? 0,
    };
  }

  return {
    status,

    /**
     * Starts a pass over the repo's eligible tasks, oldest first, one at a
     * time, and returns at once. Throws {@link MemoryBackfillBusyError} while
     * a pass runs in the repo, and `RepoRenamingError` while it is renamed.
     */
    start(repoId: string): MemoryBackfillStatus {
      const repo = repoOf(repoId);
      renaming?.assertFree(repo.id);
      if (progress.get(repo.id)?.running) throw new MemoryBackfillBusyError();
      const state: Progress = {
        running: true,
        done: 0,
        saved: 0,
        skipped: 0,
        failed: 0,
        failedIds: new Set(),
      };
      progress.set(repo.id, state);
      const signal = lifetime.signal;
      void pass(repo, state, signal)
        .catch((error: unknown) => log(`Memory backfill failed: ${errorMessage(error)}`))
        .finally(() => {
          state.running = false;
        });
      return status(repo.id);
    },

    /** Aborts every pass in flight; a later `start` runs again. */
    stop(): void {
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
