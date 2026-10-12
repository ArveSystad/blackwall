import type { AgentCli } from "@blackwall/shared";
import type { AgentPermissions } from "../permissions.js";

/** Token counts for one model call or a whole run. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Total cost in USD, when the CLI reports it. */
  costUsd?: number;
}

/** What a finished run produced. */
export interface AgentResult {
  sessionId: string;
  /** The agent's final text answer. */
  text: string;
  /** Parsed structured output, when a JSON schema was requested and honoured. */
  structured?: unknown;
  usage: AgentUsage;
}

/** One CLI event, normalized across CLIs. */
export type AgentEvent =
  /** The session id is known; persist it to resume after a crash. */
  | { type: "session"; sessionId: string; model?: string }
  /**
   * Assistant text. `parentId` on this and the tool-call events: the id of the
   * sub-agent tool call they ran under, when a sub-agent produced them.
   */
  | { type: "message"; text: string; parentId?: string }
  | { type: "tool-call-start"; id: string; name: string; input: unknown; parentId?: string }
  | { type: "tool-call-end"; id: string; output: string; isError: boolean; parentId?: string }
  /** A sub-agent started; `id` is the tool call that runs it. */
  | { type: "subagent-start"; id: string; agentType: string; description: string | null }
  /** The sub-agent of tool call `id` returned. */
  | { type: "subagent-end"; id: string }
  /** Usage of one model call. */
  | { type: "usage"; usage: AgentUsage }
  /**
   * The CLI hit its usage limit. `resetsAt` (ISO) when the CLI says when the
   * quota resets. A run that still succeeds afterwards (e.g. on overage) was
   * not stopped by it.
   */
  | { type: "rate-limit"; resetsAt?: string }
  /** The CLI reported a failure; the run ends without a result. */
  | { type: "error"; message: string }
  | { type: "result"; result: AgentResult };

export interface AgentRunOptions {
  /** Working directory: the task's worktree. */
  cwd: string;
  prompt: string;
  /**
   * Role prompt: appended to Claude's system prompt; Copilot and OpenCode have
   * no such flag, so it is prepended to the prompt body there.
   */
  systemPrompt?: string;
  model?: string;
  /** Continue an earlier session instead of starting a new one. */
  resumeSessionId?: string;
  permissions: AgentPermissions;
  /**
   * JSON Schema the final answer must match; its parsed value lands in
   * `structured`. Claude enforces it natively; Copilot and OpenCode via a
   * prompt contract.
   */
  jsonSchema?: Record<string, unknown>;
  /** Turn limit. Claude only: Copilot and OpenCode have no such flag. */
  maxTurns?: number;
  /** Aborting kills the CLI's whole process tree. */
  signal?: AbortSignal;
}

/**
 * A running agent invocation. Iterate it for live events; `result` settles
 * when the process exits, whether or not the events were consumed.
 */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  /** Resolves with the final result; rejects with {@link AgentRunError}. */
  readonly result: Promise<AgentResult>;
}

/**
 * Why a run produced no result. `session-missing`: the resumed session no
 * longer exists.
 */
export type AgentRunFailure =
  "aborted" | "cli-error" | "exit" | "invalid-output" | "session-missing" | "spawn";

export class AgentRunError extends Error {
  constructor(
    readonly reason: AgentRunFailure,
    message: string,
    /** The CLI's stderr, for diagnosis. */
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

/** Runs one CLI headless and normalizes its output. */
export interface AgentAdapter {
  readonly cli: AgentCli;
  run(options: AgentRunOptions): AgentRun;
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
