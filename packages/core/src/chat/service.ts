import { randomUUID } from "node:crypto";
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
} from "@blackwall/shared";
import { AgentRunError, type AgentAdapter, type AgentResult } from "../agents/adapters/types.js";
import { permissionsFor } from "../agents/permissions.js";
import { chatStatePrompt, chatSystemPrompt } from "../agents/prompts.js";
import type { Repositories } from "../db/repositories.js";
import { TaskStateError } from "../pipeline/engine.js";
import { RepoNotFoundError } from "../repos/service.js";

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
  tasks: Pick<Repositories["tasks"], "list">;
  backlogItems: Pick<Repositories["backlogItems"], "list">;
  messages: Pick<
    Repositories["chatMessages"],
    "list" | "latestSession" | "insert" | "setActions" | "deleteForRepo"
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

/** One repo's chat: the state clients see, plus the CLI session and the running turn. */
interface ChatEntry {
  state: ChatState;
  sessionId: string | null;
  /** The CLI `sessionId` belongs to; a turn on another CLI starts a new session. */
  sessionCli: AgentCli | null;
  /** Bumped by `/clear` and shutdown, so a turn that started before drops its result. */
  generation: number;
  controller: AbortController | null;
}

const TARGET_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "description"];
const ACTIVITY_TARGET_CHARS = 80;

/** What a tool call is doing, as the activity line shows it: `Grep · useTheme`. */
function activityFor(name: string, input: unknown): string {
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
 * The repo chat: one conversation per repo, stored in SQLite and loaded on
 * first use. Each message runs the repo's default CLI once, headless and
 * read-only in the repo's checkout, continuing the chat's CLI session; when
 * that session cannot be resumed, the prompt carries the last
 * `historyLimit` messages instead. The agent answers with a markdown reply
 * and proposed actions; the user applies those through the existing endpoints
 * and marks them applied here. The user can also add an action to an
 * assistant message themselves (e.g. turning a reply into a task). Every
 * change is published as `chat.upserted`.
 */
export function createChatService({
  adapters,
  repos,
  tasks,
  backlogItems,
  messages,
  historyLimit = CHAT_HISTORY_LIMIT,
  modelFor,
  publish,
}: ChatServiceOptions) {
  const chats = new Map<string, ChatEntry>();

  function repoOf(repoId: string): Repo {
    const repo = repos.get(repoId);
    if (!repo) throw new RepoNotFoundError(repoId);
    return repo;
  }

  function entryFor(repoId: string): ChatEntry {
    let entry = chats.get(repoId);
    if (!entry) {
      const session = messages.latestSession(repoId);
      entry = {
        state: { repoId, busy: false, activity: null, messages: messages.list(repoId) },
        sessionId: session?.sessionId ?? null,
        sessionCli: session?.cli ?? null,
        generation: 0,
        controller: null,
      };
      chats.set(repoId, entry);
    }
    return entry;
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
      role: msg.role,
      text: msg.text,
      actions: msg.actions,
      createdAt: new Date(msg.createdAt),
      ...(session ? { sessionId: session.sessionId, cli: session.cli } : {}),
    });
    return update(entry, { ...patch, messages: [...entry.state.messages, msg] });
  }

  async function runTurn(entry: ChatEntry, repo: Repo, text: string): Promise<void> {
    const generation = entry.generation;
    const current = () => entry.generation === generation;
    const controller = new AbortController();
    entry.controller = controller;
    const cli = repo.defaultCli;
    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimit: { resetsAt?: string } | undefined;

    try {
      const adapter = adapters[cli];
      if (!adapter) throw new Error(`No adapter for the ${cli} CLI`);
      const state = {
        tasks: tasks.list().filter((t) => t.repoId === repo.id && t.archivedAt === null),
        backlog: backlogItems.list(repo.id),
        text,
      };
      // The user and assistant messages before the one being answered.
      const history = entry.state.messages
        .slice(0, -1)
        .flatMap((m) => (m.role === "error" ? [] : [{ role: m.role, text: m.text }]))
        .slice(-historyLimit);
      const model = modelFor(cli);

      const attempt = async (resumeSessionId?: string): Promise<AgentResult> => {
        const run = adapter.run({
          cwd: repo.path,
          // A resumed session already holds the conversation.
          prompt: chatStatePrompt(resumeSessionId ? state : { ...state, history }),
          systemPrompt: chatSystemPrompt(),
          permissions: permissionsFor(cli, "read-only"),
          jsonSchema: chatReplyJsonSchema(),
          signal: controller.signal,
          ...(model ? { model } : {}),
          ...(resumeSessionId ? { resumeSessionId } : {}),
        });
        for await (const event of run) {
          if (!current()) continue;
          if (event.type === "session") {
            entry.sessionId = event.sessionId;
            entry.sessionCli = cli;
          }
          if (event.type === "rate-limit") {
            const resetsAt = rateLimit?.resetsAt ?? event.resetsAt;
            rateLimit = resetsAt ? { resetsAt } : {};
          }
          if (event.type === "tool-call-start") {
            update(entry, { activity: activityFor(event.name, event.input) });
          }
        }
        return run.result;
      };

      const resumeSessionId =
        entry.sessionId && entry.sessionCli === cli ? entry.sessionId : undefined;
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
        if (current()) entry.sessionId = null;
        result = await attempt();
      }
      if (!current()) return;
      entry.sessionId = result.sessionId;
      entry.sessionCli = cli;
      const parsed = chatReplySchema.safeParse(result.structured);
      const reply = parsed.success
        ? message(
            "assistant",
            parsed.data.reply,
            parsed.data.actions.map((a) => ({ ...a, id: randomUUID(), appliedAt: null })),
          )
        : message("assistant", result.text);
      append(entry, reply, { session: { sessionId: result.sessionId, cli } });
    } catch (error) {
      if (!current()) return;
      const text = rateLimit
        ? `The ${cli} CLI hit its usage limit${rateLimit.resetsAt ? ` until ${rateLimit.resetsAt}` : ""}. Try again later.`
        : error instanceof Error
          ? error.message
          : "The chat agent failed";
      append(entry, message("error", text));
    } finally {
      if (current()) {
        entry.controller = null;
        update(entry, { busy: false, activity: null });
      }
    }
  }

  return {
    /** The repo's chat; empty until the first message. */
    get(repoId: string): ChatState {
      repoOf(repoId);
      return entryFor(repoId).state;
    },

    /**
     * Sends a message and starts the agent's answer in the background.
     * `/clear` aborts any running answer and starts over; anything else is
     * refused with {@link ChatBusyError} while the chat answers.
     */
    send(repoId: string, text: string): ChatState {
      const repo = repoOf(repoId);
      const entry = entryFor(repoId);
      const trimmed = text.trim();
      if (trimmed === CHAT_CLEAR_COMMAND) {
        entry.controller?.abort();
        entry.controller = null;
        entry.generation += 1;
        entry.sessionId = null;
        entry.sessionCli = null;
        messages.deleteForRepo(repoId);
        return update(entry, { busy: false, activity: null, messages: [] });
      }
      if (entry.state.busy) throw new ChatBusyError();
      const state = append(entry, message("user", trimmed), {
        patch: { busy: true, activity: null },
      });
      void runTurn(entry, repo, trimmed);
      return state;
    },

    /**
     * Records that the user applied an action. Idempotent: a repeat keeps the
     * first `appliedAt`. Throws {@link ChatActionNotFoundError} for an action
     * not in the chat (e.g. after `/clear`).
     */
    markApplied(repoId: string, actionId: string): ChatState {
      repoOf(repoId);
      const entry = entryFor(repoId);
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
    addAction(repoId: string, messageId: string, proposal: ChatActionProposal): ChatState {
      repoOf(repoId);
      const entry = entryFor(repoId);
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
        entry.controller?.abort();
        entry.controller = null;
      }
      chats.clear();
    },

    /** Aborts every running answer; their results are dropped. */
    shutdown(): void {
      for (const entry of chats.values()) {
        entry.generation += 1;
        entry.controller?.abort();
        entry.controller = null;
      }
    },
  };
}
