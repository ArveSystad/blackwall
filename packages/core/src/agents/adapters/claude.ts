import { effortFlagApplies } from "@blackwall/shared";
import {
  guardEnv,
  permissionArgs,
  type AgentPermissions,
  type ProjectLoad,
} from "../permissions.js";
import {
  CLAUDE_PROJECT_PLUGIN,
  claudeProjectHooks,
  claudeProjectInstructions,
  prepareClaudeProjectPlugin,
  projectMcp,
} from "../project-config.js";
import { claudeSubagents } from "../subagents.js";
import { deferredRun } from "./deferred-run.js";
import { isObject, num, str, type Json } from "./json.js";
import { claudeRateLimitFromEvent, claudeRateLimitFromText } from "./rate-limit.js";
import { runAgentProcess, type LineParser } from "./run-process.js";
import type { AgentAdapter, AgentEvent, AgentRunOptions, AgentUsage } from "./types.js";
import { emptyUsage } from "./types.js";

/**
 * Claude's internal tool for `--json-schema` output. Its value arrives as the
 * result's `structured_output`, so the call is not shown as a tool call.
 */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/** The tool that runs a sub-agent; `Task` is its name before Claude Code 2.1. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

function usageFrom(raw: unknown, costUsd?: unknown): AgentUsage {
  if (!isObject(raw)) return emptyUsage();
  const usage: AgentUsage = {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
  };
  if (typeof costUsd === "number") usage.costUsd = costUsd;
  return usage;
}

/**
 * The session's usage summed over the result's per-model `modelUsage`, which,
 * unlike its `usage`, includes sub-agents. Undefined when there is none (older
 * CLIs).
 */
function modelUsageFrom(raw: unknown): AgentUsage | undefined {
  if (!isObject(raw)) return undefined;
  const models = Object.values(raw).filter(isObject);
  if (models.length === 0) return undefined;
  const usage: AgentUsage = emptyUsage();
  for (const model of models) {
    usage.inputTokens += num(model.inputTokens);
    usage.outputTokens += num(model.outputTokens);
    usage.cacheReadTokens += num(model.cacheReadInputTokens);
    usage.cacheWriteTokens += num(model.cacheCreationInputTokens);
    if (typeof model.costUSD === "number") usage.costUsd = (usage.costUsd ?? 0) + model.costUSD;
  }
  return usage;
}

/** The result line's usage: its `modelUsage` when present, else its main-thread `usage`. */
function resultUsageFrom(parsed: Json): AgentUsage {
  const usage = modelUsageFrom(parsed.modelUsage);
  if (!usage) return usageFrom(parsed.usage, parsed.total_cost_usd);
  if (usage.costUsd === undefined && typeof parsed.total_cost_usd === "number") {
    usage.costUsd = parsed.total_cost_usd;
  }
  return usage;
}

/** A tool result's content: a string or a list of text blocks. */
function toolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isObject(block) ? (str(block.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** The init line's skill names, the repo's without the harness plugin's prefix. */
function skillNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const prefix = `${CLAUDE_PROJECT_PLUGIN}:`;
  return raw
    .filter((name): name is string => typeof name === "string")
    .map((name) => (name.startsWith(prefix) ? name.slice(prefix.length) : name));
}

/**
 * Parses `claude -p --output-format stream-json --verbose` output. Hook and
 * other bookkeeping lines are dropped, as are thinking blocks and
 * `rate_limit_event` usage reports; a rejected one (the usage limit is hit)
 * becomes a `rate-limit` event, as does a usage-limit error result. A
 * sub-agent's tool call also emits `subagent-start` and `subagent-end`, and
 * the sub-agent's own messages and tool calls carry its call's id as `parentId`.
 *
 * `usage` events undercount: an assistant line carries the usage as it stood
 * when its message started (output tokens barely counted), and a sub-agent's
 * last model call is never streamed. The result's `modelUsage` is the whole
 * session's, sub-agents included, so the result's usage comes from it.
 */
export function createClaudeParser(now: () => Date = () => new Date()): LineParser {
  /**
   * Assistant messages arrive one content block per line, each repeating the
   * message-start usage; it is counted once per message.
   */
  const counted = new Set<string>();
  const hidden = new Set<string>();
  const subagents = new Set<string>();
  let sessionId: string | undefined;
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
      const parentId = str(parsed.parent_tool_use_id);
      const nested = parentId ? { parentId } : {};

      switch (parsed.type) {
        case "rate_limit_event": {
          const hit = claudeRateLimitFromEvent(parsed);
          if (hit && !limited) {
            limited = true;
            events.push({ type: "rate-limit", ...hit });
          }
          break;
        }
        case "system": {
          const id = str(parsed.session_id);
          if (parsed.subtype === "init" && id) {
            sessionId = id;
            const model = str(parsed.model);
            events.push({ type: "session", sessionId: id, ...(model ? { model } : {}) });
            // Without the Skill tool (Locked) the listed skills are out of reach.
            if (Array.isArray(parsed.tools) && parsed.tools.includes("Skill")) {
              events.push({ type: "skills-loaded", skills: skillNames(parsed.skills) });
            }
          }
          break;
        }
        case "assistant": {
          const message = parsed.message;
          if (!isObject(message)) break;
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (!isObject(block)) continue;
            if (block.type === "text") {
              const text = str(block.text);
              if (text?.trim()) events.push({ type: "message", text, ...nested });
            } else if (block.type === "tool_use") {
              const id = str(block.id) ?? "";
              const name = str(block.name) ?? "unknown";
              if (name === STRUCTURED_OUTPUT_TOOL) {
                hidden.add(id);
                continue;
              }
              const input = block.input ?? {};
              events.push({ type: "tool-call-start", id, name, input, ...nested });
              if (SUBAGENT_TOOLS.has(name) && !parentId) {
                subagents.add(id);
                const fields = isObject(input) ? input : {};
                events.push({
                  type: "subagent-start",
                  id,
                  agentType: str(fields.subagent_type) ?? "general-purpose",
                  description: str(fields.description) ?? null,
                });
              }
            }
          }
          const messageId = str(message.id);
          if (messageId && !counted.has(messageId) && isObject(message.usage)) {
            counted.add(messageId);
            events.push({ type: "usage", usage: usageFrom(message.usage) });
          }
          break;
        }
        case "user": {
          const message = parsed.message;
          if (!isObject(message) || !Array.isArray(message.content)) break;
          for (const block of message.content) {
            if (!isObject(block) || block.type !== "tool_result") continue;
            const id = str(block.tool_use_id) ?? "";
            if (hidden.has(id)) continue;
            events.push({
              type: "tool-call-end",
              id,
              output: toolOutput(block.content),
              isError: block.is_error === true,
              ...nested,
            });
            if (subagents.delete(id)) events.push({ type: "subagent-end", id });
          }
          break;
        }
        case "result": {
          const id = str(parsed.session_id) ?? sessionId ?? "";
          if (parsed.is_error === true || parsed.subtype !== "success") {
            const errors = Array.isArray(parsed.errors)
              ? parsed.errors.filter((e): e is string => typeof e === "string")
              : [];
            const message =
              errors.join("; ") ||
              str(parsed.result) ||
              `Claude Code failed (${str(parsed.subtype) ?? "unknown error"})`;
            const hit = limited ? undefined : claudeRateLimitFromText(message, now());
            if (hit) {
              limited = true;
              events.push({ type: "rate-limit", ...hit });
            }
            events.push({ type: "error", message });
            break;
          }
          events.push({
            type: "result",
            result: {
              sessionId: id,
              text: str(parsed.result) ?? "",
              ...(parsed.structured_output !== undefined
                ? { structured: parsed.structured_output }
                : {}),
              usage: resultUsageFrom(parsed),
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
 * The schema without its `$schema` dialect: Claude's validator rejects the
 * draft 2020-12 URI that zod writes, and the keywords we use need no dialect.
 */
function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

/**
 * Arguments for a headless Claude Code run. The prompt goes to stdin: it can
 * outgrow the Windows command line, and Claude's list flags (`--tools …`)
 * would swallow a trailing positional prompt.
 */
export function claudeArgs(
  options: Omit<AgentRunOptions, "cwd" | "prompt" | "signal">,
  project: ClaudeProject = {},
): string[] {
  const { model, effort, resumeSessionId, permissions, jsonSchema, maxTurns } = options;
  if (permissions.cli !== "claude") {
    throw new Error(`Permissions for ${permissions.cli} cannot run on Claude Code`);
  }
  const systemPrompt = [options.systemPrompt, project.instructions].filter(Boolean).join("\n\n");
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    ...(effort && effortFlagApplies("claude", model) ? ["--effort", effort] : []),
    ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
    ...(jsonSchema ? ["--json-schema", JSON.stringify(withoutDialect(jsonSchema))] : []),
    ...(maxTurns !== undefined ? ["--max-turns", String(maxTurns)] : []),
    ...(permissions.profile === "implement" ? ["--agents", claudeSubagents()] : []),
    ...permissionArgs(permissions, project),
  ];
}

/** What a Trusted Claude run loads from the repo: {@link ProjectLoad} plus its instruction files. */
export interface ClaudeProject extends ProjectLoad {
  /** The repo's `CLAUDE.md` files as a system prompt section. */
  instructions?: string;
}

/**
 * Reads and prepares what a Trusted run loads from the repo in `cwd`: the
 * plugin with copies of its skills and agents, its `CLAUDE.md` files, and, for
 * implementers with them turned on, its MCP servers and hooks. Locked and
 * Unrestricted runs load nothing through the harness.
 */
export async function prepareClaudeProject(
  cwd: string,
  permissions: AgentPermissions,
  pluginRoot?: string,
): Promise<{ project: ClaudeProject; dispose: () => Promise<void> }> {
  const { trust, profile } = permissions;
  if (trust.level !== "trusted") return { project: {}, dispose: async () => undefined };
  const implement = profile === "implement";
  const [plugin, instructions, mcp, hooks] = await Promise.all([
    prepareClaudeProjectPlugin(cwd, pluginRoot),
    claudeProjectInstructions(cwd),
    implement && trust.projectMcp ? projectMcp(cwd) : undefined,
    implement && trust.projectHooks ? claudeProjectHooks(cwd) : undefined,
  ]);
  return {
    project: {
      ...(plugin ? { pluginDir: plugin.dir } : {}),
      ...(instructions ? { instructions } : {}),
      ...(mcp ? { mcpConfig: mcp.path, mcpServers: mcp.servers } : {}),
      ...(hooks ? { hooks } : {}),
    },
    dispose: plugin?.dispose ?? (async () => undefined),
  };
}

/** Whether a failed `--resume` run's output says the session no longer exists. */
export function claudeSessionMissing(text: string): boolean {
  return /No conversation found with session ID/i.test(text);
}

export interface ClaudeAdapterOptions {
  /** Executable to run. Default `claude`. */
  command?: string;
  /** Arguments placed before the generated ones (e.g. a script for a fake CLI). */
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Where Trusted runs get their plugin directory. Default the OS temp dir. */
  pluginRoot?: string;
}

/**
 * Runs Claude Code headless (`claude -p`) with streamed JSON output. A
 * Trusted run first prepares what it loads from the repo (see
 * {@link prepareClaudeProject}), removed once the run settled; a guarded
 * read-only run hands the guard hook its allow list through the environment.
 */
export function createClaudeAdapter({
  command = "claude",
  commandArgs = [],
  env,
  pluginRoot,
}: ClaudeAdapterOptions = {}): AgentAdapter {
  return {
    cli: "claude",
    run({ cwd, prompt, signal, ...rest }) {
      const guard = guardEnv(rest.permissions);
      const runEnv = Object.keys(guard).length > 0 ? { ...(env ?? process.env), ...guard } : env;
      const start = (project?: ClaudeProject) =>
        runAgentProcess({
          command,
          args: [...commandArgs, ...claudeArgs(rest, project)],
          cwd,
          input: prompt,
          signal,
          parser: createClaudeParser(),
          detectRateLimit: (text) => claudeRateLimitFromText(text),
          // Only a resumed run can lose its session; gating avoids false positives.
          ...(rest.resumeSessionId ? { detectMissingSession: claudeSessionMissing } : {}),
          ...(runEnv ? { env: runEnv } : {}),
        });
      if (rest.permissions.trust.level !== "trusted") return start();
      return deferredRun("Claude Code", async () => {
        const { project, dispose } = await prepareClaudeProject(cwd, rest.permissions, pluginRoot);
        return { run: start(project), dispose };
      });
    },
  };
}
