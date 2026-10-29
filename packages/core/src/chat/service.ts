import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  CHAT_CLEAR_COMMAND,
  chatReplyJsonSchema,
  chatReplySchema,
  type AgentCli,
  type ChatAction,
  type ChatActionProposal,
  type ChatMessage,
  type ChatState,
  type Repo,
  type ServerEvent,
  type Task,
} from "@blackwall/shared";
import { AgentRunError, type AgentAdapter, type AgentResult } from "../agents/adapters/types.js";
import { permissionsFor } from "../agents/permissions.js";
import {
  chatStatePrompt,
  chatSystemPrompt,
  type ChatFocus,
  type ChatStateQuestion,
} from "../agents/prompts.js";
import type { Repositories } from "../db/repositories.js";
import { TaskNotFoundError, TaskStateError } from "../pipeline/engine.js";
import { referenceReposFrom, referenceReposOf, RepoNotFoundError } from "../repos/service.js";
import { draftReply } from "./draft.js";

/** A message sent while the chat still answers the previous one. Maps to 409 like a task state conflict. */
export class ChatBusyError extends TaskStateError {
  constructor() {
    super("The chat is still answering");
    this.name = "ChatBusyError";
  }
}

export class ChatActionNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Chat action ${id} not found`);
    this.name = "ChatActionNotFoundError";
  }
}

export class ChatMessageNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Chat message ${id} not found`);
    this.name = "ChatMessageNotFoundError";
  }
}

export interface ChatServiceOptions {
  adapters: Partial<Record<AgentCli, AgentAdapter>>;
  repos: Pick<Repositories["repos"], "get">;
  tasks: Pick<Repositories["tasks"], "list" | "get">;
  /** Grill questions; the open ones of tasks at the `questions` gate reach the prompt. */
  questions: Pick<Repositories["grillQuestions"], "listByTask">;
  backlogItems: Pick<Repositories["backlogItems"], "list">;
  messages: Pick<
    Repositories["chatMessages"],
    "list" | "latestSession" | "insert" | "setActions" | "deleteConversation"
  >;
  /** Earlier messages a turn on a fresh CLI session carries; defaults to {@link CHAT_HISTORY_LIMIT}. */
  historyLimit?: number;
  /** The model chat turns run on for a CLI; undefined runs the CLI's default. */
  modelFor: (cli: AgentCli) => string | undefined;
  publish: (event: ServerEvent) => void;
}

export type ChatService = ReturnType<typeof createChatService>;

/** Earlier user and assistant messages replayed when the CLI session cannot be resumed. */
export const CHAT_HISTORY_LIMIT = 20;

/** At most one `chat.upserted` per this many ms while a reply streams in as the draft. */
export const CHAT_DRAFT_THROTTLE_MS = 100;

/** One conversation (a repo's or a task's): the state clients see, plus the CLI session and the running turn. */
interface ChatEntry {
  state: ChatState;
  sessionId: string | null;
  /** The CLI `sessionId` belongs to; a turn on another CLI starts a new session. */
  sessionCli: AgentCli | null;
  /**
   * The directory `sessionId` ran in; a turn elsewhere starts a new session.
   * Null when unknown (a session loaded from the database), which is tried.
   */
  sessionCwd: string | null;
  /** Bumped by `/clear` and shutdown, so a turn that started before drops its result. */
  generation: number;
  controller: AbortController | null;
  /** The running turn; settles once its CLI run has ended. */
  turn: Promise<void> | null;
  /** The throttled publish of the running turn's latest draft, when one is pending. */
  draftTimer: ReturnType<typeof setTimeout> | null;
}

const TARGET_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "description"];
const ACTIVITY_TARGET_CHARS = 80;

/** What a tool call is doing, as the activity line shows it: `Grep · useTheme`. */
export function activityFor(name: string, input: unknown): string {
  const fields =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const target = value.trim().split("\n")[0]!;
    const short =
      target.length > ACTIVITY_TARGET_CHARS
        ? `${target.slice(0, ACTIVITY_TARGET_CHARS - 1)}…`
        : target;
    return `${name} · ${short}`;
  }
  return name;
}

function message(role: ChatMessage["role"], text: string, actions: ChatAction[] = []): ChatMessage {
  return { id: randomUUID(), role, text, actions, createdAt: new Date().toISOString() };
}

/**
 * The chat: one conversation per repo, plus one per task, stored in SQLite
 * and loaded on first use. A task's conversation always focuses that task
 * (archived ones too); the repo's never has a focused task. Each message runs
 * the repo's default CLI once, headless and read-only in the repo's checkout,
 * or in the focused task's worktree when it has one on disk, and may read the
 * task's reference repos (the repo's in the repo's conversation), continuing
 * the conversation's CLI session; when that session cannot
 * be resumed or ran in another directory, the prompt carries the last
 * `historyLimit` messages instead. The agent answers with a markdown reply
 * and proposed actions; the user applies those through the existing endpoints
 * and marks them applied here. The user can also add an action to an
 * assistant message themselves (e.g. turning a reply into a task). Every
 * change is published as `chat.upserted`. While the CLI writes its answer
 * (Claude and Copilot stream it), the reply so far is the live `draft`,
 * published at most every {@link CHAT_DRAFT_THROTTLE_MS}; the final reply
 * replaces it.
 */
export function createChatService({
  adapters,
  repos,
  tasks,
  questions,
  backlogItems,
  messages,
  historyLimit = CHAT_HISTORY_LIMIT,
  modelFor,
  publish,
}: ChatServiceOptions) {
  /** Keyed by `${repoId}:${taskId ?? ""}`. */
  const chats = new Map<string, ChatEntry>();
  /** Tasks being or already deleted: their chat takes no new turn. */
  const forgotten = new Set<string>();

  function repoOf(repoId: string): Repo {
    const repo = repos.get(repoId);
    if (!repo) throw new RepoNotFoundError(repoId);
    return repo;
  }

  /** The repo's task, archived or not; {@link TaskNotFoundError} for another repo's or a forgotten one. */
  function taskOf(repo: Repo, taskId: string): Task {
    const task = forgotten.has(taskId) ? undefined : tasks.get(taskId);
    if (!task || task.repoId !== repo.id) throw new TaskNotFoundError(taskId);
    return task;
  }

  function entryFor(repoId: string, taskId: string | null): ChatEntry {
    const key = `${repoId}:${taskId ?? ""}`;
    let entry = chats.get(key);
    if (!entry) {
      const session = messages.latestSession(repoId, taskId);
      entry = {
        state: {
          repoId,
          taskId,
          busy: false,
          activity: null,
          draft: null,
          messages: messages.list(repoId, taskId),
        },
        sessionId: session?.sessionId ?? null,
        sessionCli: session?.cli ?? null,
        sessionCwd: null,
        generation: 0,
        controller: null,
        turn: null,
        draftTimer: null,
      };
      chats.set(key, entry);
    }
    return entry;
  }

  /** The repo and the conversation: the task's when `taskId` is given, else the repo's. */
  function open(repoId: string, taskId: string | undefined): { repo: Repo; entry: ChatEntry } {
    const repo = repoOf(repoId);
    if (taskId !== undefined) taskOf(repo, taskId);
    return { repo, entry: entryFor(repo.id, taskId ?? null) };
  }

  /** Replaces the entry's state and announces it. */
  function update(entry: ChatEntry, patch: Partial<ChatState>): ChatState {
    entry.state = { ...entry.state, ...patch };
    publish({ type: "chat.upserted", payload: { chat: entry.state } });
    return entry.state;
  }

  /**
   * Stores a message, with the CLI session an assistant turn ended on, and
   * appends it along with any other state change.
   */
  function append(
    entry: ChatEntry,
    msg: ChatMessage,
    {
      session,
      patch,
    }: { session?: { sessionId: string; cli: AgentCli }; patch?: Partial<ChatState> } = {},
  ): ChatState {
    messages.insert({
      id: msg.id,
      repoId: entry.state.repoId,
      taskId: entry.state.taskId,
      role: msg.role,
      text: msg.text,
      actions: msg.actions,
      createdAt: new Date(msg.createdAt),
      ...(session ? { sessionId: session.sessionId, cli: session.cli } : {}),
    });
    return update(entry, { ...patch, messages: [...entry.state.messages, msg] });
  }

  /** Cancels a pending draft publish. */
  function cancelDraft(entry: ChatEntry): void {
    if (entry.draftTimer) clearTimeout(entry.draftTimer);
    entry.draftTimer = null;
  }

  /** Open questions waiting on the user, for a task at the `questions` gate. */
  function openQuestions(task: Task): ChatStateQuestion[] {
    if (task.status !== "needs-you" || task.gate !== "questions") return [];
    return questions
      .listByTask(task.id)
      .filter((q) => q.needsHuman && q.answer === null)
      .map(({ id, question }) => ({ id, question }));
  }

  async function runTurn(entry: ChatEntry, repo: Repo, text: string): Promise<void> {
    const generation = entry.generation;
    const current = () => entry.generation === generation;
    const controller = new AbortController();
    entry.controller = controller;
    const cli = repo.defaultCli;
    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimit: { resetsAt?: string } | undefined;
    /** The reply so far, and when it was last published. */
    let draft: string | null = null;
    let draftPublishedAt = 0;
    const publishDraft = () => {
      entry.draftTimer = null;
      if (!current()) return;
      draftPublishedAt = Date.now();
      update(entry, { draft });
    };
    /** Publishes a changed draft, throttled; the latest value always goes out. */
    const showDraft = (next: string | null) => {
      if (next === draft) return;
      draft = next;
      if (entry.draftTimer) return;
      const wait = draftPublishedAt + CHAT_DRAFT_THROTTLE_MS - Date.now();
      if (wait <= 0) publishDraft();
      else entry.draftTimer = setTimeout(publishDraft, wait);
    };
    /** Forgets the draft; the caller's own update clears the published one. */
    const dropDraft = () => {
      cancelDraft(entry);
      draft = null;
    };

    try {
      const adapter = adapters[cli];
      if (!adapter) throw new Error(`No adapter for the ${cli} CLI`);
      const repoTasks = tasks.list().filter((t) => t.repoId === repo.id && t.archivedAt === null);
      const open = Object.fromEntries(repoTasks.map((t) => [t.id, openQuestions(t)]));
      // A task's conversation focuses that task, archived or not; the repo's has no focus.
      const focusTask = entry.state.taskId === null ? undefined : tasks.get(entry.state.taskId);
      // The focused task's worktree, when it is still on disk, so the agent can read it.
      const worktreePath =
        focusTask?.worktreePath && existsSync(focusTask.worktreePath)
          ? focusTask.worktreePath
          : null;
      const cwd = worktreePath ?? repo.path;
      const focus: ChatFocus | undefined = focusTask
        ? {
            task: focusTask,
            questions: open[focusTask.id] ?? openQuestions(focusTask),
            ...(worktreePath
              ? {
                  worktree: {
                    path: worktreePath,
                    branch: focusTask.branch,
                    base: focusTask.baseBranch ?? repo.defaultBranch,
                  },
                }
              : {}),
          }
        : undefined;
      const state = {
        tasks: repoTasks,
        backlog: backlogItems.list(repo.id),
        questions: open,
        ...(focus ? { focus } : {}),
        text,
      };
      // The user and assistant messages before the one being answered.
      const history = entry.state.messages
        .slice(0, -1)
        .flatMap((m) => (m.role === "error" ? [] : [{ role: m.role, text: m.text }]))
        .slice(-historyLimit);
      const model = modelFor(cli);
      // A task's conversation reads the task's own reference repos, like its agents; the repo's reads the repo's.
      const refs = focusTask
        ? referenceReposFrom(repos, focusTask.repoId, focusTask.referenceRepoIds)
        : referenceReposOf(repos, repo.id);

      const attempt = async (resumeSessionId?: string): Promise<AgentResult> => {
        const run = adapter.run({
          cwd,
          // A resumed session already holds the conversation.
          prompt: chatStatePrompt(resumeSessionId ? state : { ...state, history }),
          systemPrompt: chatSystemPrompt(refs),
          permissions: permissionsFor(
            cli,
            "read-only",
            {},
            refs.map((ref) => ref.path),
          ),
          jsonSchema: chatReplyJsonSchema(),
          streamPartial: true,
          signal: controller.signal,
          ...(model ? { model } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        for await (const event of run) {
          if (!current()) continue;
          if (event.type === "session") {
            entry.sessionId = event.sessionId;
            entry.sessionCli = cli;
            entry.sessionCwd = cwd;
          }
          if (event.type === "rate-limit") {
            const resetsAt = rateLimit?.resetsAt ?? event.resetsAt;
            rateLimit = resetsAt ? { resetsAt } : {};
          }
          if (event.type === "partial") showDraft(draftReply(event));
          if (event.type === "tool-call-start") {
            // Prose written before a top-level tool call is not the reply.
            if (event.parentId === undefined) dropDraft();
            update(entry, {
              activity: activityFor(event.name, event.input),
              ...(event.parentId === undefined ? { draft: null } : {}),
            });
          }
        }
        return run.result;
      };

      // CLI sessions belong to a directory: Claude cannot resume one from elsewhere.
      const resumeSessionId =
        entry.sessionId &&
        entry.sessionCli === cli &&
        (entry.sessionCwd === null || entry.sessionCwd === cwd)
          ? entry.sessionId
          : undefined;
      let result: AgentResult;
      try {
        result = await attempt(resumeSessionId);
      } catch (error) {
        const lost =
          resumeSessionId !== undefined &&
          !controller.signal.aborted &&
          !rateLimit &&
          error instanceof AgentRunError &&
          error.reason === "session-missing";
        if (!lost) throw error;
        // The CLI no longer has the session: start a new one with the same message.
        if (current()) {
          entry.sessionId = null;
          dropDraft();
          if (entry.state.draft !== null) update(entry, { draft: null });
        }
        result = await attempt();
      }
      if (!current()) return;
      entry.sessionId = result.sessionId;
      entry.sessionCli = cli;
      entry.sessionCwd = cwd;
      const parsed = chatReplySchema.safeParse(result.structured);
      const reply = parsed.success
        ? message(
            "assistant",
            parsed.data.reply,
            parsed.data.actions.map((a) => ({ ...a, id: randomUUID(), appliedAt: null })),
          )
        : message("assistant", result.text);
      dropDraft();
      append(entry, reply, {
        session: { sessionId: result.sessionId, cli },
        patch: { draft: null },
      });
    } catch (error) {
      if (!current()) return;
      const text = rateLimit
        ? `The ${cli} CLI hit its usage limit${rateLimit.resetsAt ? ` until ${rateLimit.resetsAt}` : ""}. Try again later.`
        : error instanceof Error
          ? error.message
          : "The chat agent failed";
      dropDraft();
      append(entry, message("error", text), { patch: { draft: null } });
    } finally {
      if (current()) {
        dropDraft();
        entry.controller = null;
        update(entry, { busy: false, activity: null, draft: null });
      }
    }
  }

  return {
    /**
     * The repo's chat, or the task's own when `taskId` is given; empty until
     * the first message. Throws {@link TaskNotFoundError} for a task that is
     * not the repo's.
     */
    get(repoId: string, taskId?: string): ChatState {
      return open(repoId, taskId).entry.state;
    },

    /**
     * Sends a message and starts the agent's answer in the background.
     * `/clear` aborts any running answer and starts over; anything else is
     * refused with {@link ChatBusyError} while the conversation answers. With
     * `taskId` the message goes to that task's conversation: the prompt gives
     * the task in full, and when it has a worktree on disk the answer runs
     * read-only in it. Without, it goes to the repo's chat, which runs in the
     * repo's checkout.
     */
    send(repoId: string, text: string, taskId?: string): ChatState {
      const { repo, entry } = open(repoId, taskId);
      const trimmed = text.trim();
      if (trimmed === CHAT_CLEAR_COMMAND) {
        entry.controller?.abort();
        entry.controller = null;
        entry.generation += 1;
        cancelDraft(entry);
        entry.sessionId = null;
        entry.sessionCli = null;
        entry.sessionCwd = null;
        messages.deleteConversation(repo.id, entry.state.taskId);
        return update(entry, { busy: false, activity: null, draft: null, messages: [] });
      }
      if (entry.state.busy) throw new ChatBusyError();
      const state = append(entry, message("user", trimmed), {
        patch: { busy: true, activity: null, draft: null },
      });
      const turn: Promise<void> = runTurn(entry, repo, trimmed).finally(() => {
        if (entry.turn === turn) entry.turn = null;
      });
      entry.turn = turn;
      return state;
    },

    /**
     * Records that the user applied an action. Idempotent: a repeat keeps the
     * first `appliedAt`. Throws {@link ChatActionNotFoundError} for an action
     * not in the chat (e.g. after `/clear`).
     */
    markApplied(repoId: string, actionId: string, taskId?: string): ChatState {
      const { entry } = open(repoId, taskId);
      const found = entry.state.messages.some((m) => m.actions.some((a) => a.id === actionId));
      if (!found) throw new ChatActionNotFoundError(actionId);
      const alreadyApplied = entry.state.messages.some((m) =>
        m.actions.some((a) => a.id === actionId && a.appliedAt !== null),
      );
      if (alreadyApplied) return entry.state;
      const appliedAt = new Date().toISOString();
      return update(entry, {
        messages: entry.state.messages.map((m) => {
          if (!m.actions.some((a) => a.id === actionId)) return m;
          const actions = m.actions.map((a) => (a.id === actionId ? { ...a, appliedAt } : a));
          messages.setActions(m.id, actions);
          return { ...m, actions };
        }),
      });
    },

    /**
     * Adds an action to an assistant message, as if the agent had proposed it.
     * Allowed while the chat answers. Throws {@link ChatMessageNotFoundError}
     * for a message not in the chat (e.g. after `/clear`) or not from the assistant.
     */
    addAction(
      repoId: string,
      messageId: string,
      proposal: ChatActionProposal,
      taskId?: string,
    ): ChatState {
      const { entry } = open(repoId, taskId);
      const target = entry.state.messages.find((m) => m.id === messageId);
      if (!target || target.role !== "assistant") throw new ChatMessageNotFoundError(messageId);
      const actions: ChatAction[] = [
        ...target.actions,
        { ...proposal, id: randomUUID(), appliedAt: null },
      ];
      messages.setActions(target.id, actions);
      return update(entry, {
        messages: entry.state.messages.map((m) => (m.id === target.id ? { ...m, actions } : m)),
      });
    },

    /** Aborts every running answer and forgets every chat, e.g. before a data import. */
    reset(): void {
      for (const entry of chats.values()) {
        entry.generation += 1;
        cancelDraft(entry);
        entry.controller?.abort();
        entry.controller = null;
      }
      chats.clear();
      forgotten.clear();
    },

    /**
     * Ends a task's chat before the task is deleted: refuses new turns for it,
     * aborts its running turn and waits until that turn's CLI run has ended (so
     * nothing still runs in the worktree), then forgets the conversation. Its
     * stored messages go with the task.
     */
    async forgetTask(taskId: string): Promise<void> {
      forgotten.add(taskId);
      for (const [key, entry] of chats) {
        if (entry.state.taskId !== taskId) continue;
        entry.generation += 1;
        cancelDraft(entry);
        entry.controller?.abort();
        entry.controller = null;
        await entry.turn?.catch(() => undefined);
        chats.delete(key);
      }
    },

    /** Aborts every running answer; their results are dropped. */
    shutdown(): void {
      for (const entry of chats.values()) {
        entry.generation += 1;
        cancelDraft(entry);
        entry.controller?.abort();
        entry.controller = null;
      }
    },
  };
}
