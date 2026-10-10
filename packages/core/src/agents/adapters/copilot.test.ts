import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { permissionsFor } from "../permissions.js";
import { createClaudeAdapter, createClaudeParser } from "./claude.js";
import {
  copilotArgs,
  copilotEnv,
  copilotPrompt,
  createCopilotAdapter,
  createCopilotParser,
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
const schema = {
  type: "object",
  properties: { sum: { type: "number" }, color: { type: "string" } },
  required: ["sum", "color"],
};

function fake(mode: string, ...args: string[]) {
  return createCopilotAdapter({ command: process.execPath, commandArgs: [fakeCli, mode, ...args] });
}

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

describe("copilotEnv", () => {
  it("adds the connection's token and host", () => {
    expect(copilotEnv({ host: "jbf.ghe.com", token: "t0k" }, { PATH: "p" })).toEqual({
      PATH: "p",
      COPILOT_GITHUB_TOKEN: "t0k",
      COPILOT_GH_HOST: "jbf.ghe.com",
    });
  });

  it("leaves the environment alone without a connection", () => {
    const base = { PATH: "p" };
    expect(copilotEnv(undefined, base)).toBe(base);
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

  it("passes the connection's token and host", async () => {
    const adapter = createCopilotAdapter({
      command: process.execPath,
      commandArgs: [fakeCli, "copilot-echo"],
      auth: { host: "jbf.ghe.com", token: "t0k" },
    });
    const events = await collect(adapter.run({ cwd, prompt: "x", permissions: readOnly }));
    expect(events).toContainEqual({
      type: "message",
      text: JSON.stringify({ token: "t0k", host: "jbf.ghe.com" }),
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
