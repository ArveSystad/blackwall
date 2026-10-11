import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeConfig, permissionsFor } from "../permissions.js";
import { createClaudeAdapter, createClaudeParser } from "./claude.js";
import {
  createOpencodeAdapter,
  createOpencodeParser,
  opencodeArgs,
  opencodeEnv,
  prepareConfigHome,
  retryWhileLocked,
} from "./opencode.js";
import type { LineParser } from "./run-process.js";
import { AgentRunError, type AgentEvent, type AgentRun } from "./types.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeCli = join(fixtures, "fake-cli.js");
const fixture = (name: string) => join(fixtures, "opencode", name);

/** Every event of a recorded run, including those the parser adds once it exited with `exitCode`. */
function parseWith(parser: LineParser, path: string, exitCode: number | null = 0): AgentEvent[] {
  return [
    ...readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => parser.push(line)),
    ...(parser.end?.(exitCode) ?? []),
  ];
}

const parse = (name: string, exitCode: number | null = 0) =>
  parseWith(createOpencodeParser(), fixture(name), exitCode);

const readOnly = permissionsFor("opencode", "read-only");
const schema = {
  type: "object",
  properties: { sum: { type: "number" }, color: { type: "string" } },
  required: ["sum", "color"],
};

function fake(mode: string, args: string[] = [], env?: NodeJS.ProcessEnv) {
  return createOpencodeAdapter({
    command: process.execPath,
    commandArgs: [fakeCli, mode, ...args],
    ...(env ? { env } : {}),
  });
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const messages = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "message" ? [e.text] : []));

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

describe("createOpencodeParser", () => {
  it("normalizes a run with a tool call, announcing the session once", () => {
    const events = parse("tool-call.jsonl");
    expect(events.filter((e) => e.type !== "usage")).toEqual([
      { type: "session", sessionId: "ses_ed43d48d7ffeNioZBVBU3aydcE" },
      {
        type: "tool-call-start",
        id: "toolu_01MVVTfSU8yktsDF7zhU8DFT",
        name: "read",
        input: { filePath: "C:\\work\\a.txt" },
      },
      {
        type: "tool-call-end",
        id: "toolu_01MVVTfSU8yktsDF7zhU8DFT",
        output: expect.stringContaining("1: hello"),
        isError: false,
      },
      { type: "message", text: "hello" },
      {
        type: "result",
        result: {
          sessionId: "ses_ed43d48d7ffeNioZBVBU3aydcE",
          text: "hello",
          usage: expect.any(Object),
        },
      },
    ]);
  });

  it("reports the requested model with the session", () => {
    const events = parseWith(
      createOpencodeParser({ model: "github-copilot/claude-haiku-5.5" }),
      fixture("tool-call.jsonl"),
    );
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "ses_ed43d48d7ffeNioZBVBU3aydcE",
      model: "github-copilot/claude-haiku-5.5",
    });
  });

  it("reports each step's usage and sums it in the result", () => {
    const events = parse("tool-call.jsonl");
    expect(events.filter((e) => e.type === "usage")).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 4,
          outputTokens: 101,
          cacheReadTokens: 0,
          cacheWriteTokens: 4503,
          costUsd: 0.000613775,
        },
      },
      {
        type: "usage",
        usage: {
          inputTokens: 2,
          outputTokens: 4,
          cacheReadTokens: 4503,
          cacheWriteTokens: 203,
          costUsd: 0.000072605,
        },
      },
    ]);
    const result = events.at(-1);
    expect(result?.type === "result" && result.result.usage).toEqual({
      inputTokens: 6,
      outputTokens: 105,
      cacheReadTokens: 4503,
      cacheWriteTokens: 4706,
      costUsd: expect.closeTo(0.00068638, 10),
    });
  });

  it("reports a denied tool as a failed tool call", () => {
    const events = parse("tool-denied.jsonl");
    expect(events.find((e) => e.type === "tool-call-end")).toEqual({
      type: "tool-call-end",
      id: "toolu_017tTvFLJLwA5XAxXuFXUJfa",
      output: expect.stringContaining("prevents you from using this specific tool call"),
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: "result",
      result: { sessionId: "ses_ed43d0f9bffeBCid9atTvPEWdf" },
    });
  });

  it("takes the final text from the last step", () => {
    const parser = createOpencodeParser();
    const line = (type: string, part: object) =>
      parser.push(JSON.stringify({ type, sessionID: "ses_1", part }));
    line("step_start", {});
    line("text", { type: "text", text: "Let me look." });
    line("step_start", {});
    line("text", { type: "text", text: "Done." });
    line("step_start", {});
    expect(parser.end?.(0)).toMatchObject([{ type: "result", result: { text: "Done." } }]);

    const result = parse("json-block.jsonl").at(-1);
    expect(result?.type === "result" && result.result.text).toContain(
      '{"sum": 4, "color": "blue"}',
    );
  });

  it("turns an error event into an error and no result", () => {
    const events = parse("error.jsonl", 1);
    expect(events).toEqual([
      { type: "session", sessionId: "ses_ed43c71e6ffeRgKuo92YgaFCde" },
      { type: "error", message: "Unexpected server error. Check server logs for details." },
    ]);
  });

  it("adds a rate-limit event to a provider's limit error", () => {
    const parser = createOpencodeParser({ now: () => new Date("2026-10-09T12:00:00Z") });
    const events = parser.push(
      JSON.stringify({
        type: "error",
        sessionID: "ses_1",
        error: { name: "APIError", data: { message: "429 Too Many Requests. Try again in 5m" } },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["session", "rate-limit", "error"]);
    expect(events[1]).toEqual({ type: "rate-limit", resetsAt: "2026-10-09T12:05:00.000Z" });
  });

  it("builds the result only when the process exited cleanly without an error", () => {
    const clean = createOpencodeParser();
    clean.push('{"type":"step_start","sessionID":"ses_1","part":{}}');
    expect(clean.end?.(1)).toEqual([]);
    expect(clean.end?.(null)).toEqual([]);
    expect(clean.end?.(0)).toMatchObject([{ type: "result", result: { sessionId: "ses_1" } }]);

    const failed = createOpencodeParser();
    failed.push('{"type":"error","sessionID":"ses_1","error":{"name":"UnknownError"}}');
    expect(failed.end?.(0)).toEqual([]);

    expect(createOpencodeParser().end?.(0)).toEqual([]);
  });

  it("ignores lines that are not JSON objects", () => {
    const parser = createOpencodeParser();
    expect(parser.push("not json")).toEqual([]);
    expect(parser.push("[1,2]")).toEqual([]);
  });

  it("yields the same normalized events as Claude for the same task", () => {
    const claude = parseWith(createClaudeParser(), join(fixtures, "claude", "tool-call.jsonl"));
    expect(normalized(parse("tool-call.jsonl"))).toEqual(normalized(claude));
  });
});

describe("opencodeArgs", () => {
  it("runs the pinned blackwall agent with JSON events in the given directory", () => {
    expect(opencodeArgs({ cwd: "C:/wt" })).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "blackwall",
      "--dir",
      "C:/wt",
    ]);
  });

  it("adds the model and the session to continue", () => {
    expect(
      opencodeArgs({ cwd: "C:/wt", model: "anthropic/claude-sonnet-5-5", sessionId: "ses_1" }),
    ).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "blackwall",
      "--dir",
      "C:/wt",
      "--model",
      "anthropic/claude-sonnet-5-5",
      "--session",
      "ses_1",
    ]);
  });
});

describe("prepareConfigHome", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blackwall-opencode-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("mirrors the real config home without its opencode entry, and removes only the links", async () => {
    const real = join(root, "config");
    mkdirSync(join(real, "git"), { recursive: true });
    mkdirSync(join(real, "opencode"));
    writeFileSync(join(real, "git", "config"), "[blackwall]\n\tprobe = xdg-ok\n");
    writeFileSync(join(real, "opencode", "opencode.json"), "{}");
    const home = await prepareConfigHome({ XDG_CONFIG_HOME: real });
    expect(home.dir).not.toBe(real);
    expect(readFileSync(join(home.dir, "git", "config"), "utf8")).toContain("xdg-ok");
    expect(existsSync(join(home.dir, "opencode"))).toBe(false);
    await home.dispose();
    expect(existsSync(home.dir)).toBe(false);
    expect(existsSync(join(real, "git", "config"))).toBe(true);
    expect(existsSync(join(real, "opencode", "opencode.json"))).toBe(true);
  });
});

describe("createOpencodeAdapter", () => {
  const cwd = tmpdir();
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "blackwall-opencode-test-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The JSON the `opencode-echo` fake reports about its environment. */
  function echoed(events: AgentEvent[]) {
    return JSON.parse(messages(events).at(-1)!) as {
      PWD?: string;
      OPENCODE_CONFIG_CONTENT?: string;
      OPENCODE_DISABLE_PROJECT_CONFIG?: string;
      XDG_CONFIG_HOME?: string;
      gitConfig: string | null;
      opencodeDir: boolean;
    };
  }

  it("streams events and resolves the result from a replayed run", async () => {
    const run = fake("replay", [fixture("tool-call.jsonl")]).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    const events = await collect(run);
    expect(events[0]).toMatchObject({ type: "session" });
    expect(events.map((e) => e.type)).toContain("tool-call-start");
    expect(events.at(-1)).toMatchObject({ type: "result" });
    await expect(run.result).resolves.toMatchObject({
      sessionId: "ses_ed43d48d7ffeNioZBVBU3aydcE",
      text: "hello",
    });
  });

  it("sends the role prompt and the prompt on stdin", async () => {
    const prompt = 'line one\nline two with "quotes" and a very long tail '.repeat(200);
    const run = fake("opencode-echo").run({
      cwd,
      prompt,
      systemPrompt: "You plan.",
      permissions: readOnly,
      model: "anthropic/claude-sonnet-5-5",
    });
    const events = await collect(run);
    expect(events[0]).toEqual({
      type: "session",
      sessionId: "ses_fake",
      model: "anthropic/claude-sonnet-5-5",
    });
    expect(messages(events)[0]).toBe(`<role>\nYou plan.\n</role>\n\n${prompt}`);
    expect(JSON.parse(messages(events)[1]!)).toEqual(
      opencodeArgs({ cwd, model: "anthropic/claude-sonnet-5-5" }),
    );
    await expect(run.result).resolves.toMatchObject({ sessionId: "ses_fake" });
  });

  it("runs in the worktree whatever PWD the server has", async () => {
    const run = fake("opencode-echo", [], { ...process.env, PWD: root }).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    const events = await collect(run);
    expect(echoed(events).PWD).toBe(cwd);
    expect(JSON.parse(messages(events)[1]!)).toEqual(expect.arrayContaining(["--dir", cwd]));
  });

  it("injects the profile's rules as config and disables the worktree's config", async () => {
    const events = await collect(
      fake("opencode-echo").run({ cwd, prompt: "x", permissions: readOnly }),
    );
    const env = echoed(events);
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as {
      permission: Record<string, unknown>;
      agent: { blackwall: { permission: unknown } };
    };
    expect(config.permission).toMatchObject({ "*": "deny", read: "allow", edit: "deny" });
    expect(config.agent.blackwall.permission).toEqual(config.permission);
  });

  it("does not pass on OpenCode config variables from the environment", () => {
    const env = opencodeEnv(
      readOnly,
      { cwd: "/wt", configHome: "/mirror" },
      {
        PATH: "p",
        OPENCODE_CONFIG: "/allow-all.json",
        OPENCODE_CONFIG_DIR: "/allow-all",
        OPENCODE_CONFIG_CONTENT: '{"permission":{"*":"allow"}}',
        OPENCODE_PERMISSION: '{"*":"allow"}',
      },
    );
    expect(env).toEqual({
      PATH: "p",
      PWD: "/wt",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig(readOnly)),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      XDG_CONFIG_HOME: "/mirror",
    });
  });

  it("hides the global OpenCode config but keeps other XDG config", async () => {
    const real = join(root, "config");
    mkdirSync(join(real, "git"), { recursive: true });
    mkdirSync(join(real, "opencode"));
    writeFileSync(join(real, "git", "config"), "[blackwall]\n\tprobe = xdg-ok\n");
    writeFileSync(join(real, "opencode", "opencode.json"), '{"permission":{"*":"allow"}}');
    const run = fake("opencode-echo", [], { ...process.env, XDG_CONFIG_HOME: real }).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    const env = echoed(await collect(run));
    await run.result;
    expect(env.XDG_CONFIG_HOME).toBeDefined();
    expect(env.XDG_CONFIG_HOME).not.toBe(real);
    expect(env.gitConfig).toContain("probe = xdg-ok");
    expect(env.opencodeDir).toBe(false);
    expect(existsSync(env.XDG_CONFIG_HOME!)).toBe(false);
    expect(existsSync(join(real, "git", "config"))).toBe(true);
    expect(existsSync(join(real, "opencode", "opencode.json"))).toBe(true);
  });

  it("works without a real config home", async () => {
    const run = fake("opencode-echo", [], {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "missing"),
    }).run({ cwd, prompt: "x", permissions: readOnly });
    const env = echoed(await collect(run));
    expect(env).toMatchObject({ gitConfig: null, opencodeDir: false });
    await expect(run.result).resolves.toMatchObject({ sessionId: "ses_fake" });
  });

  it("does not mistake a successful run's stderr warning for a rate limit", async () => {
    const run = fake("opencode-echo", [], {
      ...process.env,
      FAKE_CLI_STDERR: "warning: provider returned 429 Too Many Requests, retrying",
    }).run({ cwd, prompt: "x", permissions: readOnly });
    const events = await collect(run);
    await expect(run.result).resolves.toMatchObject({ sessionId: "ses_fake" });
    expect(events.some((e) => e.type === "rate-limit")).toBe(false);
  });

  it("finds a limit in a failed run's stderr", async () => {
    const run = fake("limit").run({ cwd, prompt: "x", permissions: readOnly });
    const events = await collect(run);
    await expect(run.result).rejects.toMatchObject({ reason: "exit" });
    expect(events.find((e) => e.type === "rate-limit")).toMatchObject({
      resetsAt: expect.any(String),
    });
  });

  it("resumes the given session", async () => {
    const run = fake("opencode-echo").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      resumeSessionId: "ses_42",
    });
    const result = await run.result;
    expect(result.sessionId).toBe("ses_42");
    expect(JSON.parse(result.text.split("\n\n")[1]!)).toEqual(
      expect.arrayContaining(["--session", "ses_42"]),
    );
  });

  it("returns structured output from the JSON block", async () => {
    const run = fake("replay", [fixture("json-block.jsonl")]).run({
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
    const run = fake("replay-resume", [
      fixture("tool-call.jsonl"),
      fixture("json-repair.jsonl"),
    ]).run({ cwd, prompt: "x", permissions: readOnly, jsonSchema: schema });
    const events = await collect(run);
    expect(events.filter((e) => e.type === "session")).toHaveLength(1);
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    await expect(run.result).resolves.toMatchObject({ structured: { sum: 4, color: "green" } });
  });

  it("continues the first run's session for the repair", async () => {
    const run = fake("opencode-echo").run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
    });
    const events = await collect(run);
    await run.result.catch(() => undefined);
    const argv = messages(events)
      .filter((text) => text.startsWith("["))
      .map((text) => JSON.parse(text) as string[]);
    expect(argv).toHaveLength(2);
    expect(argv[0]).not.toContain("--session");
    expect(argv[1]).toEqual(expect.arrayContaining(["--session", "ses_fake"]));
  });

  it("fails with invalid-output when the repair is invalid too", async () => {
    const run = fake("replay-resume", [
      fixture("json-block.jsonl"),
      fixture("tool-call.jsonl"),
    ]).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: {
        ...schema,
        properties: { ...schema.properties, color: { enum: ["red", "green"] } },
      },
    });
    const events = await collect(run);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    const error = await run.result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ reason: "invalid-output" });
  });

  it("matches Claude's structured result for the same task", async () => {
    const opencode = fake("replay", [fixture("json-block.jsonl")]).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
      jsonSchema: schema,
    });
    const claude = createClaudeAdapter({
      command: process.execPath,
      commandArgs: [fakeCli, "replay", join(fixtures, "claude", "json-schema.jsonl")],
    }).run({ cwd, prompt: "x", permissions: permissionsFor("claude", "read-only") });
    const [a, b] = await Promise.all([opencode.result, claude.result]);
    expect(a.structured).toEqual(b.structured);
  });

  it("rejects with stderr when the CLI exits without a result", async () => {
    const run = fake("fail").run({ cwd, prompt: "x", permissions: readOnly });
    const error = await run.result.catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: "exit", exitCode: 3 });
    expect((error as AgentRunError).message).toContain("boom: not logged in");
  });

  it("rejects with the CLI's error", async () => {
    const run = fake("replay", [fixture("error.jsonl")]).run({
      cwd,
      prompt: "x",
      permissions: readOnly,
    });
    await expect(run.result).rejects.toMatchObject({
      reason: "cli-error",
      message: "Unexpected server error. Check server logs for details.",
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

  it("refuses permissions built for another CLI", () => {
    expect(() =>
      fake("opencode-echo").run({
        cwd,
        prompt: "x",
        permissions: permissionsFor("claude", "read-only"),
      }),
    ).toThrow(/claude/);
  });

  it("starts a run again that met a database locked by concurrent runs", async () => {
    const run = createOpencodeAdapter({
      command: process.execPath,
      commandArgs: [fakeCli, "opencode-locked", join(root, "started")],
      lockedRetryMs: 1,
    }).run({ cwd, prompt: "x", permissions: readOnly });
    const events = await collect(run);
    await expect(run.result).resolves.toMatchObject({ sessionId: "ses_fake" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

describe("retryWhileLocked", () => {
  /** A run that failed before emitting anything but its error. */
  function failed(stderr: string): AgentRun {
    const error = new AgentRunError("exit", `opencode exited with code 1: ${stderr}`, stderr, 1);
    const result = Promise.reject(error);
    result.catch(() => undefined);
    return {
      result,
      async *[Symbol.asyncIterator]() {
        yield { type: "error", message: error.message };
      },
    };
  }

  it("gives up after the last attempt, reporting the error once", async () => {
    let spawned = 0;
    const run = retryWhileLocked(
      () => {
        spawned++;
        return failed("Error: Unexpected error\n\ndatabase is locked");
      },
      { attempts: 3, delayMs: 1 },
    );
    const events = await collect(run);
    await expect(run.result).rejects.toMatchObject({ reason: "exit" });
    expect(spawned).toBe(3);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("does not retry other failures", async () => {
    let spawned = 0;
    const run = retryWhileLocked(() => {
      spawned++;
      return failed("boom: not logged in");
    });
    await expect(run.result).rejects.toMatchObject({ reason: "exit" });
    expect(spawned).toBe(1);
  });
});
