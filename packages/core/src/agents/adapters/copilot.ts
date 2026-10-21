import { effortFlagApplies } from "@blackwall/shared";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissionArgs } from "../permissions.js";
import { projectMcp } from "../project-config.js";
import { copilotSubagentFile, SUBAGENT_NAME } from "../subagents.js";
import { deferredRun } from "./deferred-run.js";
import { isObject, str } from "./json.js";
import { copilotRateLimitFromText } from "./rate-limit.js";
import { runAgentProcess, type LineParser } from "./run-process.js";
import { inlinePrompt, withStructuredOutput } from "./structured-output.js";
import type { AgentAdapter, AgentEvent, AgentRunOptions } from "./types.js";
import { emptyUsage } from "./types.js";

/** Copilot's tool that starts a sub-agent. */
const SUBAGENT_TOOL = "task";

export interface CopilotParserOptions {
  /** Session id the run was started with (`--session-id`/`--resume`), announced up front. */
  sessionId?: string;
  /** Clock for relative "try again in …" reset times. */
  now?: () => Date;
  /**
   * Report `session.skills_loaded` as `skills-loaded`: only when the run keeps
   * the `skill` tool (Trusted), since Copilot lists the skills either way.
   */
  reportSkills?: boolean;
}

/**
 * Parses `copilot --output-format json` output (JSONL session events).
 * Ephemeral events (deltas, model-call and MCP bookkeeping, reasoning) are
 * dropped, except `session.tools_updated`: it names the model the CLI actually
 * uses, reported as a second `session` event whenever it changes. The final text is the last non-empty `assistant.message`; the
 * closing `result` event carries the session id and exit code. Copilot reports
 * premium requests rather than tokens, so usage stays zero. A `session.error`
 * about a rate limit or exhausted quota also yields a `rate-limit` event.
 * A `task` tool call also emits `subagent-start` and `subagent-end`, and the
 * sub-agent's own messages and tool calls carry its call's id
 * (`data.parentToolCallId`) as `parentId`; their text is never the final
 * text. Copilot's `subagent.*` lifecycle events repeat the tool call's and are
 * dropped. The top-level `parentId` of every event only chains events.
 * `session.skills_loaded`, also ephemeral, yields `skills-loaded` when
 * `reportSkills` is set.
 */
export function createCopilotParser({
  sessionId,
  now = () => new Date(),
  reportSkills = false,
}: CopilotParserOptions = {}): LineParser {
  let announced = false;
  let reportedModel: string | undefined;
  let text = "";
  let sessionError: string | undefined;
  let limited = false;
  const subagents = new Set<string>();

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
      const parentId = str(data.parentToolCallId);
      const nested = parentId ? { parentId } : {};

      // The id is fixed by the arguments, so it can be persisted before any output matters.
      if (!announced && sessionId) {
        announced = true;
        events.push({ type: "session", sessionId });
      }
      if (parsed.type === "session.tools_updated" && sessionId) {
        const model = str(data.model);
        if (model && model !== reportedModel) {
          reportedModel = model;
          events.push({ type: "session", sessionId, model });
        }
      }
      if (parsed.type === "session.skills_loaded" && reportSkills) {
        const skills = Array.isArray(data.skills) ? data.skills.filter(isObject) : [];
        events.push({
          type: "skills-loaded",
          skills: skills
            .filter((skill) => skill.enabled !== false)
            .map((skill) => str(skill.name))
            .filter((name): name is string => !!name),
        });
      }
      if (parsed.ephemeral === true) return events;

      switch (parsed.type) {
        case "assistant.message": {
          const content = str(data.content);
          if (content?.trim()) {
            if (!parentId) text = content;
            events.push({ type: "message", text: content, ...nested });
          }
          break;
        }
        case "tool.execution_start": {
          const id = str(data.toolCallId) ?? "";
          const name = str(data.toolName) ?? "unknown";
          const input = data.arguments ?? {};
          events.push({ type: "tool-call-start", id, name, input, ...nested });
          if (name === SUBAGENT_TOOL && !parentId) {
            subagents.add(id);
            const args = isObject(input) ? input : {};
            // A plugin's agent is named `<plugin>:<agent>`.
            const agentType = str(args.agent_type)?.split(":").at(-1) || "general-purpose";
            events.push({
              type: "subagent-start",
              id,
              agentType,
              description: str(args.description) ?? null,
            });
          }
          break;
        }
        case "tool.execution_complete": {
          const ok = data.success === true;
          const output = ok
            ? isObject(data.result)
              ? (str(data.result.content) ?? "")
              : ""
            : isObject(data.error)
              ? (str(data.error.message) ?? "")
              : "";
          const id = str(data.toolCallId) ?? "";
          events.push({ type: "tool-call-end", id, output, isError: !ok, ...nested });
          if (subagents.delete(id)) events.push({ type: "subagent-end", id });
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
 * flag: see {@link inlinePrompt}.
 */
export function copilotPrompt(
  options: Pick<AgentRunOptions, "prompt" | "systemPrompt" | "jsonSchema">,
): string {
  return inlinePrompt(options);
}

export interface CopilotArgsOptions extends Pick<
  AgentRunOptions,
  "cwd" | "model" | "effort" | "permissions"
> {
  /** Session to use: a fresh UUID for a new session, or the one to resume. */
  sessionId: string;
  resume: boolean;
  /** Harness plugin to load (`--plugin-dir`): see {@link prepareCopilotPlugin}. */
  pluginDir?: string;
  /** Trusted implementers with the repo's MCP servers turned on: its `.mcp.json`. */
  mcpConfig?: string;
}

/**
 * Arguments for a headless Copilot CLI run. The prompt goes to stdin, which
 * Copilot treats like `-p <text>` but without the Windows command-line limit.
 * A new session gets its id up front through `--session-id`.
 *
 * Under Trusted the repo's skills and agents load through `--add-dir` (see
 * {@link permissionArgs}). Copilot has no way to load them without the user's
 * own `~/.copilot` agents, skills and MCP servers, which also hold its login,
 * so a Trusted run loads those too: hence `TRUSTED_LOADS_GLOBAL_CONFIG`.
 */
export function copilotArgs({
  cwd,
  model,
  effort,
  permissions,
  sessionId,
  resume,
  pluginDir,
  mcpConfig,
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
    ...(effort && effortFlagApplies("copilot", model) ? ["--reasoning-effort", effort] : []),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(pluginDir ? ["--plugin-dir", pluginDir] : []),
    ...permissionArgs(permissions, { cwd, ...(mcpConfig ? { mcpConfig } : {}) }),
  ];
}

/** Whether a failed `--resume` run's output says the session no longer exists. */
export function copilotSessionMissing(text: string): boolean {
  return /No session, task, or name matched/i.test(text);
}

/** A GitHub connection's host and token, for Copilot authentication. */
export interface CopilotAuth {
  /** e.g. `github.com` or `acme.ghe.com`. */
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

/** The harness plugin's name; Copilot names its agents `<plugin>:<agent>`. */
export const COPILOT_PLUGIN = "blackwall";

/** A per-run plugin directory; `dispose` removes it. */
export interface CopilotPlugin {
  dir: string;
  dispose: () => Promise<void>;
}

/**
 * A plugin directory defining the worker sub-agent, loaded with
 * `--plugin-dir`. Copilot reads it in place, so neither the worktree nor the
 * user's `~/.copilot` is written to, and it loads even with
 * `--disallow-temp-dir`.
 */
export async function prepareCopilotPlugin(root: string = tmpdir()): Promise<CopilotPlugin> {
  const dir = await mkdtemp(join(root, "blackwall-copilot-"));
  const dispose = () => rm(dir, { recursive: true, force: true });
  try {
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({ name: COPILOT_PLUGIN, description: "Blackwall harness agents" }),
    );
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", `${SUBAGENT_NAME}.agent.md`), copilotSubagentFile());
  } catch (error) {
    await dispose();
    throw error;
  }
  return { dir, dispose };
}

export interface CopilotAdapterOptions {
  /** Executable to run. Default `copilot`. */
  command?: string;
  /** Arguments placed before the generated ones (e.g. a script for a fake CLI). */
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** GitHub connection to authenticate with, instead of Copilot's stored login. */
  auth?: CopilotAuth;
  /** Where implement runs get their plugin directory. Default the OS temp dir. */
  pluginRoot?: string;
}

/**
 * Runs GitHub Copilot CLI headless with JSONL output. Structured output uses a
 * prompt contract (a fenced JSON block), validated against the schema with one
 * repair turn on the same session. Implement runs load a per-run plugin
 * defining the worker sub-agent, removed once the run settled.
 */
export function createCopilotAdapter({
  command = "copilot",
  commandArgs = [],
  env,
  auth,
  pluginRoot,
}: CopilotAdapterOptions = {}): AgentAdapter {
  const runEnv = env || auth ? copilotEnv(auth, env) : undefined;
  return {
    cli: "copilot",
    run({
      cwd,
      prompt,
      systemPrompt,
      jsonSchema,
      resumeSessionId,
      model,
      effort,
      permissions,
      signal,
    }) {
      const sessionId = resumeSessionId ?? randomUUID();
      const start = (pluginDir?: string, mcpConfig?: string) => {
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
                ...(effort ? { effort } : {}),
                ...(pluginDir ? { pluginDir } : {}),
                ...(mcpConfig ? { mcpConfig } : {}),
              }),
            ],
            cwd,
            input,
            signal,
            parser: createCopilotParser({
              sessionId,
              reportSkills: permissions.trust.level !== "locked",
            }),
            detectRateLimit: (text) => copilotRateLimitFromText(text),
            // Only a resumed run can lose its session; gating avoids false positives.
            ...(resumeSessionId !== undefined
              ? { detectMissingSession: copilotSessionMissing }
              : {}),
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
      };

      if (permissions.profile !== "implement") return start();
      const { trust } = permissions;
      return deferredRun("Copilot", async () => {
        const mcp =
          trust.level === "trusted" && trust.projectMcp ? await projectMcp(cwd) : undefined;
        const plugin = await prepareCopilotPlugin(pluginRoot);
        return { run: start(plugin.dir, mcp?.path), dispose: plugin.dispose };
      });
    },
  };
}
