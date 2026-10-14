import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { permissionsFor } from "../permissions.js";
import { claudeArgs, createClaudeAdapter, createClaudeParser } from "./claude.js";
import { isAlive } from "./process.js";
import { AgentRunError, type AgentEvent } from "./types.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeCli = join(fixtures, "fake-cli.js");
const fixture = (name: string) => join(fixtures, "claude", name);

function parse(name: string): AgentEvent[] {
  const parser = createClaudeParser();
  return readFileSync(fixture(name), "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => parser.push(line));
}

const readOnly = permissionsFor("claude", "read-only");

function fake(mode: string, ...args: string[]) {
  return createClaudeAdapter({ command: process.execPath, commandArgs: [fakeCli, mode, ...args] });
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createClaudeParser", () => {
  it("normalizes a run with a tool call", () => {
    const events = parse("tool-call.jsonl");
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "tool-call-start",
      "usage",
      "tool-call-end",
      "message",
      "usage",
      "result",
    ]);
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "ab6b04aa-4095-4123-976d-fb2a5509c276",
      model: "claude-haiku-5-5",
    });
    expect(events[1]).toMatchObject({
      type: "tool-call-start",
      id: "toolu_01F2yHtDJwRJ33oZEndHReit",
      name: "Read",
      input: { file_path: "/work\\a.txt" },
    });
    expect(events[3]).toEqual({
      type: "tool-call-end",
      id: "toolu_01F2yHtDJwRJ33oZEndHReit",
      output: "1\thello\n2\t",
      isError: false,
    });
    expect(events[4]).toEqual({ type: "message", text: "hello" });
    expect(events[6]).toEqual({
      type: "result",
      result: {
        sessionId: "ab6b04aa-4095-4123-976d-fb2a5509c276",
        text: "hello",
        usage: {
          inputTokens: 4,
          outputTokens: 81,
          cacheReadTokens: 11490,
          cacheWriteTokens: 4091,
          costUsd: 0.000974,
        },
      },
    });
  });

  it("returns structured output and hides the StructuredOutput tool", () => {
    const events = parse("json-schema.jsonl");
    expect(events.some((e) => e.type === "tool-call-start" || e.type === "tool-call-end")).toBe(
      false,
    );
    // Thinking blocks are dropped; one usage event per model call.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    const result = events.at(-1);
    expect(result).toMatchObject({
      type: "result",
      result: { structured: { sum: 4, color: "blue" }, text: '{"sum":4,"color":"blue"}' },
    });
  });

  it("reports a failed resume as an error", () => {
    expect(parse("resume-missing.jsonl")).toEqual([
      {
        type: "error",
        message: "No conversation found with session ID: 00000000-0000-0000-0000-000000000000",
      },
    ]);
  });

  it("reports hitting the turn limit as an error", () => {
    const events = parse("max-turns.jsonl");
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Reached maximum number of turns (1)",
    });
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("reports a sub-agent and tags its events with the parent call", () => {
    const events = parse("subagent.jsonl");
    const agentId = "toolu_01SNs8DrwmmKhdJqmyBUpmd4";
    expect(events.filter((e) => e.type !== "usage").map((e) => e.type)).toEqual([
      "session",
      "message",
      "tool-call-start",
      "subagent-start",
      "tool-call-start",
      "tool-call-end",
      "tool-call-end",
      "subagent-end",
      "message",
      "result",
    ]);
    expect(events).toContainEqual({
      type: "subagent-start",
      id: agentId,
      agentType: "blackwall-worker",
      description: "Read a.txt and report contents",
    });
    const nested = events.filter((e) => "parentId" in e);
    expect(nested.map((e) => e.type)).toEqual(["tool-call-start", "tool-call-end"]);
    expect(nested.every((e) => "parentId" in e && e.parentId === agentId)).toBe(true);
    expect(events.find((e) => e.type === "tool-call-start")).not.toHaveProperty("parentId");
    expect(events.at(-1)).toMatchObject({ type: "result", result: { text: "hello" } });
  });

  it("takes the result's usage from modelUsage, sub-agents included", () => {
    const result = parse("subagent.jsonl").at(-1);
    expect(result?.type === "result" && result.result.usage).toEqual({
      inputTokens: 35,
      outputTokens: 542,
      cacheReadTokens: 21397,
      cacheWriteTokens: 22112,
      costUsd: 0.043222699999999996,
    });
  });

  it("handles the legacy Task tool name", () => {
    const parser = createClaudeParser();
    const start = parser.push(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "x" } }],
        },
      }),
    );
    expect(start).toContainEqual({
      type: "subagent-start",
      id: "t1",
      agentType: "x",
      description: null,
    });
    const end = parser.push(
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
      }),
    );
    expect(end.map((e) => e.type)).toEqual(["tool-call-end", "subagent-end"]);
  });

  it("ignores lines that are not JSON objects", () => {
    const parser = createClaudeParser();
    expect(parser.push("not json")).toEqual([]);
    expect(parser.push("[1,2]")).toEqual([]);
    expect(parser.push('{"type":"rate_limit_event"}')).toEqual([]);
  });
});

describe("claudeArgs", () => {
  it("builds headless flags with permissions last", () => {
    const args = claudeArgs({
      permissions: readOnly,
      model: "opus",
      resumeSessionId: "s-1",
      systemPrompt: "You review code.",
      jsonSchema: { type: "object" },
      maxTurns: 30,
    });
    expect(args.slice(0, 15)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
      "--resume",
      "s-1",
      "--append-system-prompt",
      "You review code.",
      "--json-schema",
      '{"type":"object"}',
      "--max-turns",
      "30",
      "--restricted",
    ]);
    expect(args).toContain("--disallowedTools");
  });

  it("drops the JSON Schema dialect Claude cannot load", () => {
    const args = claudeArgs({
      permissions: readOnly,
      jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
    });
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
  });

  it("omits optional flags", () => {
    const args = claudeArgs({ permissions: readOnly });
    for (const flag of ["--model", "--resume", "--append-system-prompt", "--json-schema"]) {
      expect(args).not.toContain(flag);
    }
    expect(args).not.toContain("--max-turns");
  });

  it("defines the worker sub-agent for implementers only", () => {
    const args = claudeArgs({ permissions: permissionsFor("claude", "implement") });
    const agents = JSON.parse(args[args.indexOf("--agents") + 1] ?? "{}");
    expect(agents["blackwall-worker"]).toMatchObject({
      model: "haiku",
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    });
    expect(agents["blackwall-worker"].prompt).not.toContain("\n");
    expect(agents["blackwall-worker"].prompt).toContain("Do not commit, push");
    expect(claudeArgs({ permissions: readOnly })).not.toContain("--agents");
  });

  it("refuses permissions built for another CLI", () => {
    expect(() => claudeArgs({ permissions: permissionsFor("copilot", "read-only") })).toThrow(
      /copilot/,
    );
  });
});

describe("createClaudeAdapter", () => {
  const cwd = tmpdir();

  it("streams events and resolves the result from a replayed run", async () => {
    const run = fake("replay", fixture("tool-call.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    const events = await collect(run);
    expect(events.map((e) => e.type)).toContain("tool-call-start");
    await expect(run.result).resolves.toMatchObject({ text: "hello" });
  });

  it("settles the result without anyone iterating", async () => {
    const run = fake("replay", fixture("json-schema.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "blue" } });
  });

  it("sends the prompt on stdin", async () => {
    const prompt = 'line one\nline two with "quotes" and a very long tail '.repeat(200);
    const run = fake("echo").run({ cwd, prompt, permissions: readOnly, model: "haiku" });
    const result = await run.result;
    expect(result.text).toBe(prompt);
    expect(result.structured).toEqual(expect.arrayContaining(["-p", "--model", "haiku"]));
  });

  it("rejects a resume of a lost session as session-missing", async () => {
    const run = fake("replay", fixture("resume-missing.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      resumeSessionId: "00000000-0000-0000-0000-000000000000",
    });
    await expect(run.result).rejects.toMatchObject({
      reason: "session-missing",
      message: expect.stringContaining("No conversation found"),
    });
  });

  it("rejects with the CLI's error message", async () => {
    const run = fake("replay", fixture("resume-missing.jsonl")).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    await expect(run.result).rejects.toMatchObject({
      reason: "cli-error",
      message: expect.stringContaining("No conversation found"),
    });
  });

  it("rejects with stderr when the CLI exits without a result", async () => {
    const run = fake("fail").run({ cwd, prompt: "x", permissions: readOnly });
    const events = await collect(run);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    const error = await run.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ reason: "exit", exitCode: 3 });
    expect((error as AgentRunError).stderr).toContain("boom: not logged in");
    expect((error as AgentRunError).message).toContain("boom: not logged in");
  });

  it("rejects when the executable is missing", async () => {
    const adapter = createClaudeAdapter({ command: "blackwall-no-such-cli" });
    const run = adapter.run({ cwd, prompt: "x", permissions: readOnly });
    await expect(run.result).rejects.toMatchObject({ reason: "spawn" });
  });

  it("does not start when already aborted", async () => {
    const run = fake("hang").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      signal: AbortSignal.abort(),
    });
    await expect(run.result).rejects.toMatchObject({ reason: "aborted" });
  });

  it("kills the whole process tree on abort", { timeout: 20_000 }, async () => {
    const controller = new AbortController();
    const run = fake("hang").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      signal: controller.signal,
    });
    let grandchild = 0;
    for await (const event of run) {
      if (event.type === "session") {
        grandchild = Number(event.sessionId);
        expect(isAlive(grandchild)).toBe(true);
        controller.abort();
      }
    }
    await expect(run.result).rejects.toMatchObject({ reason: "aborted" });
    await expect.poll(() => isAlive(grandchild), { timeout: 5_000 }).toBe(false);
  });
});
