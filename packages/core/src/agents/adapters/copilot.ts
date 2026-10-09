import { randomUUID } from "node:crypto";
import { permissionArgs } from "../permissions.js";
import { copilotRateLimitFromText } from "./rate-limit.js";
import { runAgentProcess, type LineParser } from "./run-process.js";
import { structuredOutputContract, withStructuredOutput } from "./structured-output.js";
import type { AgentAdapter, AgentEvent, AgentRunOptions } from "./types.js";
import { emptyUsage } from "./types.js";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface CopilotParserOptions {
  /** Session id the run was started with (`--session-id`/`--resume`), announced up front. */
  sessionId?: string;
  /** Model requested with `--model`, until the CLI reports the one it uses. */
  model?: string;
  /** Clock for relative "try again in …" reset times. */
  now?: () => Date;
}

/**
 * Parses `copilot --output-format json` output (JSONL session events).
 * Ephemeral events (deltas, model-call and MCP bookkeeping, reasoning) are
 * dropped. The final text is the last non-empty `assistant.message`; the
 * closing `result` event carries the session id and exit code. Copilot reports
 * premium requests rather than tokens, so usage stays zero. A `session.error`
 * about a rate limit or exhausted quota also yields a `rate-limit` event.
 */
export function createCopilotParser({
  sessionId,
  model,
  now = () => new Date(),
}: CopilotParserOptions = {}): LineParser {
  let announced = false;
  let text = "";
  let sessionError: string | undefined;
  let limited = false;

  return {
    push(line) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      if (!isObject(parsed)) return [];
      const events: AgentEvent[] = [];
      const data = isObject(parsed.data) ? parsed.data : {};

      // The id is fixed by the arguments, so it can be persisted before any output matters.
      if (!announced && sessionId) {
        announced = true;
        events.push({ type: "session", sessionId, ...(model ? { model } : {}) });
      }
      if (parsed.ephemeral === true) return events;

      switch (parsed.type) {
        case "assistant.message": {
          const content = str(data.content);
          if (content?.trim()) {
            text = content;
            events.push({ type: "message", text: content });
          }
          break;
        }
        case "tool.execution_start":
          events.push({
            type: "tool-call-start",
            id: str(data.toolCallId) ?? "",
            name: str(data.toolName) ?? "unknown",
            input: data.arguments ?? {},
          });
          break;
        case "tool.execution_complete": {
          const ok = data.success === true;
          const output = ok
            ? isObject(data.result)
              ? (str(data.result.content) ?? "")
              : ""
            : isObject(data.error)
              ? (str(data.error.message) ?? "")
              : "";
          events.push({
            type: "tool-call-end",
            id: str(data.toolCallId) ?? "",
            output,
            isError: !ok,
          });
          break;
        }
        case "session.error": {
          sessionError = str(data.message) ?? sessionError;
          const hit =
            limited || !sessionError ? undefined : copilotRateLimitFromText(sessionError, now());
          if (hit) {
            limited = true;
            events.push({ type: "rate-limit", ...hit });
          }
          break;
        }
        case "result": {
          const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
          if (exitCode !== 0) {
            events.push({
              type: "error",
              message: sessionError ?? `Copilot CLI failed (exit code ${exitCode})`,
            });
            break;
          }
          events.push({
            type: "result",
            result: {
              sessionId: str(parsed.sessionId) ?? sessionId ?? "",
              text,
              usage: emptyUsage(),
            },
          });
          break;
        }
      }
      return events;
    },
  };
}

/**
 * Prompt body for Copilot, which has neither a system-prompt nor a JSON-schema
 * flag: the role prompt goes first and the structured-output contract last.
 */
export function copilotPrompt({
  prompt,
  systemPrompt,
  jsonSchema,
}: Pick<AgentRunOptions, "prompt" | "systemPrompt" | "jsonSchema">): string {
  return [
    ...(systemPrompt ? [`<role>\n${systemPrompt}\n</role>`] : []),
    prompt,
    ...(jsonSchema ? [structuredOutputContract(jsonSchema)] : []),
  ].join("\n\n");
}

export interface CopilotArgsOptions extends Pick<AgentRunOptions, "cwd" | "model" | "permissions"> {
  /** Session to use: a fresh UUID for a new session, or the one to resume. */
  sessionId: string;
  resume: boolean;
}

/**
 * Arguments for a headless Copilot CLI run. The prompt goes to stdin, which
 * Copilot treats like `-p <text>` but without the Windows command-line limit.
 * A new session gets its id up front through `--session-id`.
 */
export function copilotArgs({
  cwd,
  model,
  permissions,
  sessionId,
  resume,
}: CopilotArgsOptions): string[] {
  if (permissions.cli !== "copilot") {
    throw new Error(`Permissions for ${permissions.cli} cannot run on Copilot CLI`);
  }
  return [
    "--output-format",
    "json",
    "-C",
    cwd,
    ...(model ? ["--model", model] : []),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...permissionArgs(permissions),
  ];
}

/** A GitHub connection's host and token, for Copilot authentication. */
export interface CopilotAuth {
  /** e.g. `github.com` or `jbf.ghe.com`. */
  host: string;
  token: string;
}

/**
 * Environment for a Copilot run: the base environment plus
 * `COPILOT_GITHUB_TOKEN`/`COPILOT_GH_HOST` when a connection is configured.
 * Without one, Copilot uses its own stored login.
 */
export function copilotEnv(
  auth: CopilotAuth | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!auth) return base;
  return { ...base, COPILOT_GITHUB_TOKEN: auth.token, COPILOT_GH_HOST: auth.host };
}

export interface CopilotAdapterOptions {
  /** Executable to run. Default `copilot`. */
  command?: string;
  /** Arguments placed before the generated ones (e.g. a script for a fake CLI). */
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** GitHub connection to authenticate with, instead of Copilot's stored login. */
  auth?: CopilotAuth;
}

/**
 * Runs GitHub Copilot CLI headless with JSONL output. Structured output uses a
 * prompt contract (a fenced JSON block), validated against the schema with one
 * repair turn on the same session.
 */
export function createCopilotAdapter({
  command = "copilot",
  commandArgs = [],
  env,
  auth,
}: CopilotAdapterOptions = {}): AgentAdapter {
  const runEnv = env || auth ? copilotEnv(auth, env) : undefined;
  return {
    cli: "copilot",
    run({ cwd, prompt, systemPrompt, jsonSchema, resumeSessionId, model, permissions, signal }) {
      const sessionId = resumeSessionId ?? randomUUID();
      const spawn = (input: string, resume: boolean) =>
        runAgentProcess({
          command,
          args: [
            ...commandArgs,
            ...copilotArgs({
              cwd,
              permissions,
              sessionId,
              resume,
              ...(model ? { model } : {}),
            }),
          ],
          cwd,
          input,
          signal,
          parser: createCopilotParser({ sessionId, ...(model ? { model } : {}) }),
          detectRateLimit: (text) => copilotRateLimitFromText(text),
          ...(runEnv ? { env: runEnv } : {}),
        });

      const first = spawn(
        copilotPrompt({
          prompt,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(jsonSchema ? { jsonSchema } : {}),
        }),
        resumeSessionId !== undefined,
      );
      if (!jsonSchema) return first;
      return withStructuredOutput(first, jsonSchema, (repair) => spawn(repair, true));
    },
  };
}
