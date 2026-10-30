import { LOCKED_TRUST, type AgentTrust } from "@blackwall/shared";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { permissionsFor } from "../permissions.js";
import { COPILOT_SUBAGENT_MODEL } from "../subagents.js";
import { createClaudeAdapter, createClaudeParser } from "./claude.js";
import {
  copilotArgs,
  copilotEnv,
  copilotPrompt,
  createCopilotAdapter,
  createCopilotParser,
  copilotSessionMissing,
  prepareCopilotPlugin,
} from "./copilot.js";
import type { LineParser } from "./run-process.js";
import { AgentRunError, type AgentEvent } from "./types.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeCli = join(fixtures, "fake-cli.js");
const fixture = (name: string) => join(fixtures, "copilot", name);

function parseWith(parser: LineParser, path: string): AgentEvent[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => parser.push(line));
}

const parse = (name: string, sessionId?: string) =>
  parseWith(createCopilotParser(sessionId ? { sessionId } : {}), fixture(name));

const readOnly = permissionsFor("copilot", "read-only");
const implement = permissionsFor("copilot", "implement");
const trustAt = (level: AgentTrust["level"]): AgentTrust => ({ ...LOCKED_TRUST, level });

/** The skill lists of the `skills-loaded` events in a run. */
const skillsOf = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "skills-loaded" ? [e.skills] : []));
const schema = {
  type: "object",
  properties: { sum: { type: "number" }, color: { type: "string" } },
  required: ["sum", "color"],
};

function fake(mode: string, ...args: string[]) {
  return createCopilotAdapter({ command: process.execPath, commandArgs: [fakeCli, mode, ...args] });
}

/** Copilot CLI 1.0.96's stderr for `--resume` of an unknown or deleted session (exit code 1). */
const RESUME_MISSING_STDERR = `Error: No session, task, or name matched '00000000-0000-0000-0000-000000000000'.

To resume by session or task ID:  copilot --resume=<id>
To resume by name:                copilot --resume=<name>
To name a new session:            copilot --name=<name>
To pick from existing sessions:   copilot --resume
To start a new session with ID:   copilot --session-id=<valid-uuid>`;

/** Replays a resume of a session Copilot no longer has. */
const resumeMissing = () =>
  createCopilotAdapter({
    command: process.execPath,
    commandArgs: [fakeCli, "replay-exit", fixture("resume-missing.jsonl"), "1"],
    env: { ...process.env, FAKE_CLI_STDERR: RESUME_MISSING_STDERR },
  });

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** What two CLIs should agree on for the same task: event kinds, texts and outcome. */
function normalized(events: AgentEvent[]) {
  const firstSession = events.find((e) => e.type === "session");
  return events
    .filter((e) => e.type !== "usage" && (e.type !== "session" || e === firstSession))
    .map((e) => {
      switch (e.type) {
        case "session":
          return { type: e.type };
        case "message":
          return { type: e.type, text: e.text };
        case "tool-call-start":
          return { type: e.type };
        case "tool-call-end":
          return { type: e.type, isError: e.isError };
        case "subagent-start":
          return { type: e.type, agentType: e.agentType };
        case "subagent-end":
          return { type: e.type };
        case "result":
          return { type: e.type, text: e.result.text, structured: e.result.structured };
        default:
          return e;
      }
    });
}

describe("createCopilotParser", () => {
  it("normalizes a run with a tool call, reporting the model from session.tools_updated", () => {
    const events = parse("tool-call.jsonl", "acc98e74-9ed5-4338-8941-64ce5b9fcd79");
    expect(events).toEqual([
      { type: "session", sessionId: "acc98e74-9ed5-4338-8941-64ce5b9fcd79" },
      {
        type: "session",
        sessionId: "acc98e74-9ed5-4338-8941-64ce5b9fcd79",
        model: "claude-sonnet-5.5",
      },
      {
        type: "tool-call-start",
        id: "toolu_011R3FAVheTWyCQc6XYKQREV",
        name: "view",
        input: { path: "C:\\work\\a.txt" },
      },
      {
        type: "tool-call-end",
        id: "toolu_011R3FAVheTWyCQc6XYKQREV",
        output: "hello\n",
        isError: false,
      },
      { type: "message", text: "hello" },
      {
        type: "result",
        result: {
          sessionId: "acc98e74-9ed5-4338-8941-64ce5b9fcd79",
          text: "hello",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
    ]);
  });

  it("reports a denied tool as a failed tool call", () => {
    const events = parse("tool-denied.jsonl");
    expect(events.find((e) => e.type === "tool-call-end")).toEqual({
      type: "tool-call-end",
      id: "toolu_01VkzRgKUiY2gbtr4pieRKvn",
      output: "Permission to run this tool was denied due to the following rules: `write`",
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { sessionId: "28d7ae67-9a36-4acd-8113-a2db002ce5c4" },
    });
  });

  it("takes the final text from the last assistant message", () => {
    const events = parse("json-block.jsonl");
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result" });
    expect(result?.type === "result" && result.result.text).toContain(
      '{"sum": 4, "color": "blue"}',
    );
    expect(events.filter((e) => e.type === "message")).toHaveLength(1);
  });

  it("announces the session once, then the model the CLI reports", () => {
    const parser = createCopilotParser({ sessionId: "s-1" });
    const toolsUpdated =
      '{"type":"session.tools_updated","data":{"model":"claude-sonnet-5.5"},"ephemeral":true}';
    expect(parser.push(toolsUpdated)).toEqual([
      { type: "session", sessionId: "s-1" },
      { type: "session", sessionId: "s-1", model: "claude-sonnet-5.5" },
    ]);
    expect(parser.push(toolsUpdated)).toEqual([]);
    expect(parser.push('{"type":"assistant.turn_start","data":{}}')).toEqual([]);
  });

  it("announces the session without a model when none is reported", () => {
    const parser = createCopilotParser({ sessionId: "s-1" });
    expect(parser.push('{"type":"session.tools_updated","data":{},"ephemeral":true}')).toEqual([
      { type: "session", sessionId: "s-1" },
    ]);
  });

  it("reports a non-zero exit code as an error", () => {
    const parser = createCopilotParser();
    parser.push('{"type":"session.error","data":{"message":"Rate limited"}}');
    expect(parser.push('{"type":"result","sessionId":"s","exitCode":1}')).toEqual([
      { type: "error", message: "Rate limited" },
    ]);
  });

  it("ignores lines that are not JSON objects", () => {
    const parser = createCopilotParser();
    expect(parser.push("not json")).toEqual([]);
    expect(parser.push("[1,2]")).toEqual([]);
  });

  it("yields the same normalized events as Claude for the same task", () => {
    const claude = parseWith(createClaudeParser(), join(fixtures, "claude", "tool-call.jsonl"));
    const copilot = parse("tool-call.jsonl", "acc98e74-9ed5-4338-8941-64ce5b9fcd79");
    expect(normalized(copilot)).toEqual(normalized(claude));
  });

  it("reports the repo's skills only when the run keeps the skill tool", () => {
    const locked = parseWith(
      createCopilotParser({ reportSkills: false }),
      fixture("skills-locked.jsonl"),
    );
    expect(skillsOf(locked)).toEqual([]);
    const trusted = parseWith(
      createCopilotParser({ reportSkills: true }),
      fixture("skills-trusted.jsonl"),
    );
    expect(skillsOf(trusted)).toHaveLength(1);
    expect(skillsOf(trusted)[0]).toEqual(expect.arrayContaining(["ghprobe", "probe"]));
  });

  it("reports the repo's skills as Claude does for the same task", () => {
    const claude = parseWith(
      createClaudeParser(),
      join(fixtures, "claude", "skills-trusted.jsonl"),
    );
    const copilot = parseWith(
      createCopilotParser({ reportSkills: true }),
      fixture("skills-trusted.jsonl"),
    );
    expect(skillsOf(claude)[0]).toContain("probe");
    expect(skillsOf(copilot)[0]).toContain("probe");
  });

  it("streams the top-level message as cumulative partial text when asked", () => {
    const events = parseWith(createCopilotParser({ partial: true }), fixture("chat-partial.jsonl"));
    const partials = events.filter((e) => e.type === "partial");
    expect(partials.length).toBeGreaterThan(5);
    expect(partials.every((e) => !e.json)).toBe(true);
    for (const [i, event] of partials.entries()) {
      expect(event.text.startsWith(partials[i - 1]?.text ?? "")).toBe(true);
    }
    const message = events.find((e) => e.type === "message");
    expect(partials.at(-1)?.text).toBe(message?.type === "message" ? message.text : undefined);
    expect(events.filter((e) => e.type !== "partial")).toEqual(parse("chat-partial.jsonl"));
  });

  it("emits no partial events unless asked", () => {
    expect(parse("chat-partial.jsonl").some((e) => e.type === "partial")).toBe(false);
  });

  it("restarts the partial text per message and ignores sub-agents' deltas", () => {
    const parser = createCopilotParser({ partial: true });
    const delta = (messageId: string, deltaContent: string, parentToolCallId?: string) =>
      parser.push(
        JSON.stringify({
          type: "assistant.message_delta",
          data: { messageId, deltaContent, ...(parentToolCallId ? { parentToolCallId } : {}) },
          ephemeral: true,
        }),
      );
    expect(delta("m1", "Let me ")).toEqual([{ type: "partial", text: "Let me ", json: false }]);
    expect(delta("m1", "look.")).toEqual([{ type: "partial", text: "Let me look.", json: false }]);
    expect(delta("s1", "nested", "call-1")).toEqual([]);
    expect(delta("m2", "Done")).toEqual([{ type: "partial", text: "Done", json: false }]);
  });

  it("reports a sub-agent and tags its events with the parent call", () => {
    const events = parse("subagent.jsonl", "11111111-2222-4333-8444-555555555559");
    const agentId = "toolu_019WkP85pw4zcjYmigRASgV6";
    expect(events.filter((e) => e.type !== "session").map((e) => e.type)).toEqual([
      "tool-call-start",
      "subagent-start",
      "tool-call-start",
      "tool-call-end",
      "tool-call-end",
      "subagent-end",
      // The worker's report arrives after its task call returned.
      "message",
      "message",
      "result",
    ]);
    expect(events).toContainEqual({
      type: "subagent-start",
      id: agentId,
      agentType: "blackwall-worker",
      description: "Read a.txt content",
    });
    const nested = events.filter((e) => "parentId" in e);
    expect(nested.map((e) => e.type)).toEqual(["tool-call-start", "tool-call-end", "message"]);
    expect(nested.every((e) => "parentId" in e && e.parentId === agentId)).toBe(true);
    const first = events.find((e) => e.type === "tool-call-start");
    expect(first).toMatchObject({ id: agentId, name: "task" });
    expect(first).not.toHaveProperty("parentId");
    expect(events.at(-1)).toMatchObject({ type: "result", result: { text: "hello" } });
  });

  it("never takes the final text from a sub-agent's message", () => {
    const parser = createCopilotParser();
    parser.push('{"type":"assistant.message","data":{"content":"mine"}}');
    expect(
      parser.push(
        '{"type":"assistant.message","data":{"content":"worker report","parentToolCallId":"t1"}}',
      ),
    ).toEqual([{ type: "message", text: "worker report", parentId: "t1" }]);
    expect(parser.push('{"type":"result","sessionId":"s","exitCode":0}')).toMatchObject([
      { type: "result", result: { text: "mine" } },
    ]);
  });

  it("reports a built-in sub-agent by its type", () => {
    const parser = createCopilotParser();
    const start = parser.push(
      JSON.stringify({
        type: "tool.execution_start",
        data: { toolCallId: "t1", toolName: "task", arguments: { agent_type: "general-purpose" } },
      }),
    );
    expect(start).toContainEqual({
      type: "subagent-start",
      id: "t1",
      agentType: "general-purpose",
      description: null,
    });
  });

  it("reports the same sub-agent events and result as Claude for the same task", () => {
    // The CLIs differ in the messages around the delegation, not in the delegation itself.
    const delegation = (events: AgentEvent[]) =>
      normalized(events).filter((e) =>
        ["subagent-start", "subagent-end", "result"].includes(e.type),
      );
    const claude = parseWith(createClaudeParser(), join(fixtures, "claude", "subagent.jsonl"));
    const copilot = parse("subagent.jsonl", "11111111-2222-4333-8444-555555555559");
    expect(delegation(copilot)).toEqual(delegation(claude));
  });
});

describe("copilotPrompt", () => {
  it("prepends the role prompt and appends the JSON contract", () => {
    const body = copilotPrompt({
      prompt: "Do it.",
      systemPrompt: "You review code.",
      jsonSchema: schema,
    });
    expect(body.startsWith("<role>\nYou review code.\n</role>\n\nDo it.\n\n")).toBe(true);
    expect(body).toContain("```json");
    expect(body.endsWith(JSON.stringify(schema))).toBe(true);
  });

  it("is the bare prompt without role or schema", () => {
    expect(copilotPrompt({ prompt: "Do it." })).toBe("Do it.");
  });
});

describe("copilotArgs", () => {
  it("builds headless flags with permissions last", () => {
    const args = copilotArgs({
      cwd: "C:\\wt",
      model: "gpt-5",
      permissions: readOnly,
      sessionId: "s-1",
      resume: false,
    });
    expect(args.slice(0, 9)).toEqual([
      "--output-format",
      "json",
      "-C",
      "C:\\wt",
      "--model",
      "gpt-5",
      "--session-id",
      "s-1",
      "--no-ask-user",
    ]);
    expect(args).toContain("--deny-tool=write");
  });

  it("passes the effort after the model, and none when unset", () => {
    const base = { cwd: "x", permissions: readOnly, sessionId: "s-1", resume: false };
    const args = copilotArgs({ ...base, model: "claude-haiku-5.5", effort: "low" });
    expect(args.slice(4, 8)).toEqual(["--model", "claude-haiku-5.5", "--reasoning-effort", "low"]);
    expect(copilotArgs({ ...base, model: "gpt-5" })).not.toContain("--reasoning-effort");
  });

  it("skips the effort for a model Copilot takes none for", () => {
    const args = copilotArgs({
      cwd: "x",
      permissions: readOnly,
      sessionId: "s-1",
      resume: true,
      model: "auto",
      effort: "low",
    });
    expect(args).not.toContain("--reasoning-effort");
  });

  it("loads the plugin directory before the permission flags", () => {
    const args = copilotArgs({
      cwd: "x",
      permissions: implement,
      sessionId: "s-1",
      resume: false,
      pluginDir: "C:\\plugin",
    });
    expect(args.slice(4, 9)).toEqual([
      "--session-id",
      "s-1",
      "--plugin-dir",
      "C:\\plugin",
      "--no-ask-user",
    ]);
    expect(
      copilotArgs({ cwd: "x", permissions: implement, sessionId: "s", resume: false }),
    ).not.toContain("--plugin-dir");
  });

  it("adds reference repo dirs among the permission flags, keeping the rest in order", () => {
    const base = { cwd: "x", sessionId: "s-1", resume: false };
    const args = copilotArgs({
      ...base,
      permissions: permissionsFor("copilot", "read-only", {}, ["/refs/a"]),
    });
    const at = args.indexOf("--add-dir");
    expect(args.slice(at - 1, at + 2)).toEqual(["--disallow-temp-dir", "--add-dir", "/refs/a"]);
    expect(args.filter((_, i) => i < at || i >= at + 2)).toEqual(
      copilotArgs({ ...base, permissions: readOnly }),
    );
  });

  it("excludes the skill tool when Locked and keeps it under Trusted", () => {
    const base = { cwd: "C:\\wt", sessionId: "s-1", resume: false };
    const locked = copilotArgs({ ...base, permissions: permissionsFor("copilot", "read-only") });
    expect(locked).toContain("--excluded-tools=skill");
    expect(locked).not.toContain("--add-dir");

    const trusted = copilotArgs({
      ...base,
      permissions: permissionsFor("copilot", "read-only", {}, [], trustAt("trusted")),
    });
    expect(trusted[trusted.indexOf("--add-dir") + 1]).toBe("C:\\wt");
    expect(trusted).not.toContain("--excluded-tools=skill");
  });

  it("passes the repo's MCP config to Trusted implementers with project MCP on", () => {
    const trust = { ...trustAt("trusted"), projectMcp: true };
    const args = copilotArgs({
      cwd: "C:\\wt",
      sessionId: "s-1",
      resume: false,
      permissions: permissionsFor("copilot", "implement", {}, [], trust),
      mcpConfig: "C:\\wt\\.mcp.json",
    });
    expect(args[args.indexOf("--additional-mcp-config") + 1]).toBe("@C:\\wt\\.mcp.json");
    const readOnlyArgs = copilotArgs({
      cwd: "C:\\wt",
      sessionId: "s-1",
      resume: false,
      permissions: permissionsFor("copilot", "read-only", {}, [], trust),
      mcpConfig: "C:\\wt\\.mcp.json",
    });
    expect(readOnlyArgs).not.toContain("--additional-mcp-config");
  });

  it("runs Unrestricted with no rules but its own allow-all flags", () => {
    const args = copilotArgs({
      cwd: "C:\\wt",
      sessionId: "s-1",
      resume: false,
      permissions: permissionsFor("copilot", "read-only", {}, [], trustAt("unrestricted")),
    });
    expect(args).toEqual([
      "--output-format",
      "json",
      "-C",
      "C:\\wt",
      "--session-id",
      "s-1",
      "--no-ask-user",
      "--allow-all",
    ]);
  });

  it("resumes an existing session", () => {
    const args = copilotArgs({ cwd: "x", permissions: readOnly, sessionId: "s-1", resume: true });
    expect(args).toEqual(expect.arrayContaining(["--resume", "s-1"]));
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--model");
  });

  it("refuses permissions built for another CLI", () => {
    expect(() =>
      copilotArgs({
        cwd: "x",
        permissions: permissionsFor("claude", "read-only"),
        sessionId: "s",
        resume: false,
      }),
    ).toThrow(/claude/);
  });
});

describe("copilotSessionMissing", () => {
  it("recognises Copilot's message for a session it no longer has", () => {
    expect(copilotSessionMissing(RESUME_MISSING_STDERR)).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(copilotSessionMissing("boom: not logged in")).toBe(false);
    expect(copilotSessionMissing("Error: 429 Too Many Requests: rate limit exceeded.")).toBe(false);
    expect(copilotSessionMissing("Error: file not found: src/index.ts")).toBe(false);
  });
});

describe("copilotEnv", () => {
  it("adds the connection's token and host", () => {
    expect(copilotEnv({ host: "acme.ghe.com", token: "t0k" }, { PATH: "p" })).toEqual({
      PATH: "p",
      COPILOT_GITHUB_TOKEN: "t0k",
      COPILOT_GH_HOST: "acme.ghe.com",
    });
  });

  it("leaves the environment alone without a connection", () => {
    const base = { PATH: "p" };
    expect(copilotEnv(undefined, base)).toBe(base);
  });
});

describe("prepareCopilotPlugin", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blackwall-copilot-test-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a plugin defining the worker under the root, and removes it", async () => {
    const plugin = await prepareCopilotPlugin("implement", root);
    expect(join(plugin.dir, "..")).toBe(root);
    expect(JSON.parse(readFileSync(join(plugin.dir, "plugin.json"), "utf8"))).toMatchObject({
      name: "blackwall",
    });
    const agent = readFileSync(join(plugin.dir, "agents", "blackwall-worker.agent.md"), "utf8");
    expect(agent.startsWith("---\nname: blackwall-worker\n")).toBe(true);
    expect(agent).toContain(`model: ${COPILOT_SUBAGENT_MODEL}\n`);
    expect(agent).toContain('tools: ["read","search","edit","shell"]\n');
    expect(agent).toContain("Do not commit, push");
    await plugin.dispose();
    expect(existsSync(plugin.dir)).toBe(false);
  });

  it("writes a read-only worker for read-only runs", async () => {
    const plugin = await prepareCopilotPlugin("read-only", root);
    const agent = readFileSync(join(plugin.dir, "agents", "blackwall-worker.agent.md"), "utf8");
    expect(agent).toContain(`model: ${COPILOT_SUBAGENT_MODEL}\n`);
    expect(agent).toContain('tools: ["read","search","shell"]\n');
    expect(agent).not.toContain("Do not commit, push");
    await plugin.dispose();
  });
});

describe("createCopilotAdapter", () => {
  const cwd = tmpdir();

  it("streams events and resolves the result from a replayed run", async () => {
    const run = fake("replay", fixture("tool-call.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    const events = await collect(run);
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.map((e) => e.type)).toContain("tool-call-start");
    await expect(run.result).resolves.toMatchObject({ text: "hello" });
  });

  it("sends the prompt with the role prompt on stdin and starts a fresh session", async () => {
    const prompt = 'line one\nline two with "quotes" and a very long tail '.repeat(200);
    const run = fake("copilot-echo").run({
      cwd,
      prompt,
      systemPrompt: "You plan.",
      permissions: readOnly,
      model: "gpt-5",
    });
    const events = await collect(run);
    const session = events[0];
    expect(session).toMatchObject({ type: "session" });
    expect(session).not.toHaveProperty("model");
    expect(events[1]).toMatchObject({ type: "session", model: "fake" });
    const messages = events.flatMap((e) => (e.type === "message" ? [e.text] : []));
    expect(messages[0]).toBe(`<role>\nYou plan.\n</role>\n\n${prompt}`);
    const result = await run.result;
    const args = JSON.parse(result.text) as string[];
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-5", "-C", cwd]));
    expect(args[args.indexOf("--session-id") + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(session?.type === "session" && session.sessionId).toBe(result.sessionId);
  });

  it("passes the effort to the CLI", async () => {
    const run = fake("copilot-echo").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      effort: "low",
    });
    await collect(run);
    const args = JSON.parse((await run.result).text) as string[];
    expect(args).toEqual(expect.arrayContaining(["--reasoning-effort", "low"]));
  });

  it("resumes the given session", async () => {
    const run = fake("copilot-echo").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      resumeSessionId: "s-42",
    });
    const result = await run.result;
    expect(result.sessionId).toBe("s-42");
    expect(JSON.parse(result.text)).toEqual(expect.arrayContaining(["--resume", "s-42"]));
  });

  it("loads the worker plugin for implementers and removes it after the run", async () => {
    const root = mkdtempSync(join(tmpdir(), "blackwall-copilot-test-"));
    try {
      const adapter = createCopilotAdapter({
        command: process.execPath,
        commandArgs: [fakeCli, "copilot-echo"],
        pluginRoot: root,
      });
      const run = adapter.run({ cwd, prompt: "x", permissions: implement });
      const events = await collect(run);
      const report = events.find((e) => e.type === "message" && e.text.startsWith('{"plugin"'));
      const { plugin, worker } = JSON.parse(report?.type === "message" ? report.text : "{}") as {
        plugin: string;
        worker: boolean;
      };
      expect(join(plugin, "..")).toBe(root);
      expect(worker).toBe(true);
      await run.result;
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives reviewers no plugin", async () => {
    const run = fake("copilot-echo").run({ cwd, prompt: "x", permissions: readOnly });
    const result = await run.result;
    expect(JSON.parse(result.text)).not.toContain("--plugin-dir");
  });

  it("passes the connection's token and host", async () => {
    const adapter = createCopilotAdapter({
      command: process.execPath,
      commandArgs: [fakeCli, "copilot-echo"],
      auth: { host: "acme.ghe.com", token: "t0k" },
    });
    const events = await collect(adapter.run({ cwd, prompt: "x", permissions: readOnly }));
    expect(events).toContainEqual({
      type: "message",
      text: JSON.stringify({ token: "t0k", host: "acme.ghe.com" }),
    });
  });

  it("returns structured output from the JSON block", async () => {
    const run = fake("replay", fixture("json-block.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
    });
    const events = await collect(run);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "blue" } });
  });

  it("repairs a missing JSON block once on the same session", async () => {
    const run = fake("replay-resume", fixture("tool-call.jsonl"), fixture("json-block.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
    });
    const events = await collect(run);
    // The announcement and the reported model, both from the first run; the repair adds none.
    expect(events.filter((e) => e.type === "session")).toHaveLength(2);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "blue" } });
  });

  it("streams the first run's partial text", async () => {
    const run = fake("replay", fixture("json-block.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
      streamPartial: true,
    });
    const events = await collect(run);
    expect(events.some((e) => e.type === "partial")).toBe(true);
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "blue" } });
  });

  it("streams no partial text from the repair run", async () => {
    const run = fake("replay-resume", fixture("tool-call.jsonl"), fixture("json-block.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
      streamPartial: true,
    });
    const events = await collect(run);
    const first = parseWith(createCopilotParser({ partial: true }), fixture("tool-call.jsonl"));
    expect(events.filter((e) => e.type === "partial")).toEqual(
      first.filter((e) => e.type === "partial"),
    );
    expect(JSON.stringify(events)).not.toContain('"text":"2+2 ="');
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "blue" } });
  });

  it("fails with invalid-output when the repair is invalid too", async () => {
    const strict = {
      ...schema,
      properties: { ...schema.properties, color: { enum: ["red", "green"] } },
    };
    const run = fake(
      "replay-resume",
      fixture("json-block.jsonl"),
      fixture("json-repair.jsonl"),
    ).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: strict,
    });
    const events = await collect(run);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    const error = await run.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({
      reason: "invalid-output",
      message: expect.stringContaining("color"),
    });
  });

  it("matches Claude's structured result for the same task", async () => {
    const copilot = fake("replay", fixture("json-block.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
    });
    const claude = createClaudeAdapter({
      command: process.execPath,
      commandArgs: [fakeCli, "replay", join(fixtures, "claude", "json-schema.jsonl")],
    }).run({ cwd, prompt: "x", permissions: permissionsFor("claude", "read-only") });
    const [a, b] = await Promise.all([copilot.result, claude.result]);
    expect(a.structured).toEqual(b.structured);
  });

  it("rejects with stderr when the CLI exits without a result", async () => {
    const run = fake("fail").run({ cwd, prompt: "x", permissions: readOnly });
    const error = await run.result.catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "exit", exitCode: 3 });
    expect((error as AgentRunError).message).toContain("boom: not logged in");
  });

  it("rejects a resume of a lost session as session-missing", async () => {
    const run = resumeMissing().run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      resumeSessionId: "00000000-0000-0000-0000-000000000000",
    });
    await expect(run.result).rejects.toMatchObject({
      reason: "session-missing",
      exitCode: 1,
      message: expect.stringContaining("No session, task, or name matched"),
    });
  });

  it("rejects the same output on a fresh run as a plain exit", async () => {
    const run = resumeMissing().run({ cwd, prompt: "x", permissions: readOnly });
    await expect(run.result).rejects.toMatchObject({
      reason: "exit",
      message: expect.stringContaining("No session, task, or name matched"),
    });
  });

  it("does not start when already aborted", async () => {
    const run = fake("hang").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
      signal: AbortSignal.abort(),
    });
    await expect(run.result).rejects.toMatchObject({ reason: "aborted" });
  });
});
