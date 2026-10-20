import { randomBytes } from "node:crypto";
import type {
  AgentCli,
  BacklogItem,
  NewBacklogItemInput,
  Repo,
  ServerEvent,
  Task,
  VoiceState,
} from "@blackwall/shared";
import type { AgentAdapter } from "../agents/adapters/types.js";
import { permissionsFor } from "../agents/permissions.js";
import { voiceCommandPrompt, voiceSystemPrompt } from "../agents/prompts.js";
import { activityFor } from "../chat/service.js";
import type { Repositories } from "../db/repositories.js";
import { TaskStateError } from "../pipeline/engine.js";
import { RepoNotFoundError } from "../repos/service.js";
import { VOICE_TOOL_NAMES, VOICE_TOOLS, VoiceToolError, type VoiceToolContext } from "./tools.js";

/** A command sent while the last one still runs. Maps to 409 like a task state conflict. */
export class VoiceBusyError extends TaskStateError {
  constructor() {
    super("Still working on the last voice command");
    this.name = "VoiceBusyError";
  }
}

/** A submit of a draft that is gone, replaced or already being created. Maps to 409. */
export class VoiceDraftConflictError extends TaskStateError {
  constructor() {
    super("The task draft was already created or closed");
    this.name = "VoiceDraftConflictError";
  }
}

/** Claude's turn limit for a voice command: a few tool calls and the reply. */
export const VOICE_MAX_TURNS = 8;

export interface VoiceCommandServiceOptions {
  adapters: Partial<Record<AgentCli, AgentAdapter>>;
  repos: Pick<Repositories["repos"], "get">;
  backlogItems: Pick<Repositories["backlogItems"], "list">;
  /** The global and per-repo backlog runner switches. */
  runner: VoiceToolContext["runner"];
  /** Promotes a waiting backlog item of the repo to a task now. */
  runBacklogItem: (repoId: string, itemId: string) => Task;
  /** Adds a backlog item through the same path as the New task form; starts it when the runner would. */
  submitTask: (repoId: string, input: NewBacklogItemInput) => Promise<BacklogItem>;
  /** The model voice turns run on for a CLI; undefined runs the CLI's default. */
  modelFor: (cli: AgentCli) => string | undefined;
  /** Where the CLIs reach the blackwall MCP server, read at each turn. */
  mcpUrl: () => string;
  publish: (event: ServerEvent) => void;
}

export type VoiceCommandService = ReturnType<typeof createVoiceCommandService>;

/** A turn's MCP access, from its bearer token. */
export interface VoiceTurnAccess {
  token: string;
  repoId: string;
}

const IDLE: VoiceState = {
  busy: false,
  repoId: null,
  transcript: null,
  activity: null,
  reply: null,
  error: null,
  draft: null,
  created: null,
};

/**
 * Voice commands: each transcript runs the repo's default CLI once, headless,
 * Locked and read-only in the repo's checkout, with the blackwall MCP server
 * attached through a bearer token minted for the turn and revoked when it
 * ends. The agent acts only through the tools in {@link VOICE_TOOLS}, at once.
 * The New task draft lives here, so every client mirrors it and its task is
 * created exactly once, by voice or the form ({@link submitDraft}). One turn
 * runs at a time; turns hold no scheduler slot. Every change is published as
 * `voice.upserted`.
 */
export function createVoiceCommandService({
  adapters,
  repos,
  backlogItems,
  runner,
  runBacklogItem,
  submitTask,
  modelFor,
  mcpUrl,
  publish,
}: VoiceCommandServiceOptions) {
  let state: VoiceState = IDLE;
  /** Bumped by reset and shutdown, so a turn that started before drops its result. */
  let generation = 0;
  let controller: AbortController | null = null;
  /** Live turn tokens, each bound to its turn's repo. */
  const tokens = new Map<string, string>();

  function update(patch: Partial<VoiceState>): VoiceState {
    state = { ...state, ...patch };
    publish({ type: "voice.upserted", payload: { voice: state } });
    return state;
  }

  /**
   * Creates the draft's task once. The claim is synchronous: a second submit
   * of the same draft, by voice or a form in any tab, gets
   * {@link VoiceDraftConflictError}. On failure the draft stays open.
   */
  async function submitDraft(id: string, input?: NewBacklogItemInput): Promise<BacklogItem> {
    const draft = state.draft;
    if (!draft || draft.id !== id || draft.submitting) throw new VoiceDraftConflictError();
    update({ draft: { ...draft, submitting: true } });
    try {
      const item = await submitTask(
        draft.repoId,
        input
          ? { ...input, start: true }
          : {
              origin: { kind: "free-text" },
              title: draft.title,
              freeText: draft.description,
              start: true,
            },
      );
      update({
        draft: state.draft?.id === id ? null : state.draft,
        created: {
          repoId: item.repoId,
          itemId: item.id,
          taskId: item.taskId ?? null,
          title: item.title,
        },
      });
      return item;
    } catch (error) {
      if (state.draft?.id === id) update({ draft: { ...state.draft, submitting: false } });
      throw error;
    }
  }

  function toolContext(repoId: string): VoiceToolContext {
    return {
      repoId,
      draft: { get: () => state.draft, set: (draft) => void update({ draft }) },
      submitDraft: (id) => submitDraft(id),
      runBacklogItem,
      backlogItems,
      runner,
      publishBacklogChanged: (id) => publish({ type: "backlog.changed", payload: { repoId: id } }),
    };
  }

  async function runTurn(repo: Repo, text: string): Promise<void> {
    const turn = generation;
    const current = () => generation === turn;
    const turnController = new AbortController();
    controller = turnController;
    const token = randomBytes(32).toString("base64url");
    tokens.set(token, repo.id);
    const cli = repo.defaultCli;
    /** Set when the CLI reported its usage limit; matters only if the run then fails. */
    let rateLimit: { resetsAt?: string } | undefined;

    try {
      const adapter = adapters[cli];
      if (!adapter) throw new Error(`No adapter for the ${cli} CLI`);
      const draft = state.draft;
      const prompt = voiceCommandPrompt({
        text,
        backlog: backlogItems
          .list(repo.id)
          .filter((i) => i.status === "waiting")
          .map(({ id, title }) => ({ id, title })),
        runner: {
          enabled: runner.repoBacklogRunner(repo.id).enabled,
          global: runner.general().backlogRunner,
        },
        draft: draft ? { title: draft.title, description: draft.description } : null,
      });
      const model = modelFor(cli);
      const run = adapter.run({
        cwd: repo.path,
        prompt,
        systemPrompt: voiceSystemPrompt(),
        permissions: {
          ...permissionsFor(cli, "read-only"),
          harnessMcp: {
            name: "blackwall",
            url: mcpUrl(),
            headers: { Authorization: `Bearer ${token}` },
            tools: VOICE_TOOL_NAMES,
          },
        },
        maxTurns: VOICE_MAX_TURNS,
        signal: turnController.signal,
        ...(model ? { model } : {}),
      });
      for await (const event of run) {
        if (!current()) continue;
        if (event.type === "rate-limit") {
          const resetsAt = rateLimit?.resetsAt ?? event.resetsAt;
          rateLimit = resetsAt ? { resetsAt } : {};
        }
        if (event.type === "tool-call-start") {
          update({ activity: activityFor(event.name, event.input) });
        }
      }
      const result = await run.result;
      if (!current()) return;
      update({ reply: result.text.trim() || null });
    } catch (error) {
      if (!current()) return;
      update({
        error: rateLimit
          ? `The ${cli} CLI hit its usage limit${rateLimit.resetsAt ? ` until ${rateLimit.resetsAt}` : ""}. Try again later.`
          : error instanceof Error
            ? error.message
            : "The voice command failed",
      });
    } finally {
      tokens.delete(token);
      if (current()) {
        controller = null;
        update({ busy: false, activity: null });
      }
    }
  }

  function stop(): void {
    generation += 1;
    controller?.abort();
    controller = null;
    tokens.clear();
    state = { ...state, busy: false, activity: null };
  }

  return {
    state: (): VoiceState => state,

    /**
     * Runs a transcript as a command in the background. Refused with
     * {@link VoiceBusyError} while the last one runs, and with
     * {@link RepoNotFoundError} for an unknown repo.
     */
    command(repoId: string, text: string): VoiceState {
      if (state.busy) throw new VoiceBusyError();
      const repo = repos.get(repoId);
      if (!repo) throw new RepoNotFoundError(repoId);
      const next = update({
        busy: true,
        repoId,
        transcript: text,
        activity: null,
        reply: null,
        error: null,
        created: null,
      });
      void runTurn(repo, text);
      return next;
    },

    /** The turn a bearer token belongs to; null for a missing, unknown or revoked one. */
    authorize(token: string | undefined): VoiceTurnAccess | null {
      if (!token) return null;
      const repoId = tokens.get(token);
      return repoId === undefined ? null : { token, repoId };
    },

    /** Runs a tool for a turn; throws {@link VoiceToolError} for the agent to read. */
    async callTool(access: VoiceTurnAccess, name: string, input: unknown): Promise<string> {
      if (tokens.get(access.token) !== access.repoId) {
        throw new VoiceToolError("The voice command has ended");
      }
      const found = VOICE_TOOLS.find((t) => t.name === name);
      if (!found) throw new VoiceToolError(`Unknown tool ${name}`);
      return found.run(toolContext(access.repoId), input);
    },

    submitDraft,

    /** Closes the draft; a stale id, or a draft being created, is left alone. */
    clearDraft(id: string): VoiceState {
      if (state.draft?.id !== id || state.draft.submitting) return state;
      return update({ draft: null });
    },

    /** Aborts the running turn and forgets everything, e.g. before a data import. */
    reset(): void {
      stop();
      state = IDLE;
      publish({ type: "voice.upserted", payload: { voice: state } });
    },

    /** Aborts the running turn; its result is dropped. */
    shutdown: stop,
  };
}
