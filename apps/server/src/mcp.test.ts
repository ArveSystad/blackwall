import {
  createFakeAdapter,
  createRepositories,
  createSettingsService,
  createVoiceCommandService,
  openDatabase,
  type FakeAdapter,
  type OpenedDatabase,
  type Repositories,
  type VoiceCommandService,
} from "@blackwall/core";
import type { BacklogItem, NewBacklogItemInput, ServerEvent } from "@blackwall/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const port = 4711;
const host = `127.0.0.1:${port}`;
let opened: OpenedDatabase;
let r: Repositories;
let repoId: string;
let events: ServerEvent[];
let adapter: FakeAdapter;
let submitTask: ReturnType<
  typeof vi.fn<(repoId: string, input: NewBacklogItemInput) => Promise<BacklogItem>>
>;
let commands: VoiceCommandService;
let app: Hono;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
  events = [];
  // Each turn runs until aborted, so its token stays live.
  adapter = createFakeAdapter("claude", () => ({ hang: true }));
  submitTask = vi.fn(async (id: string, input: NewBacklogItemInput) => ({
    ...r.backlogItems.insert({
      repoId: id,
      title: input.title ?? "",
      origin: { kind: "free-text" },
      freeText: input.freeText ?? "",
    }),
    taskId: "t1",
    status: "promoted" as const,
  }));
  commands = createVoiceCommandService({
    adapters: { claude: adapter },
    repos: r.repos,
    tasks: r.tasks,
    questions: r.grillQuestions,
    answerQuestion: vi.fn(),
    approvePlan: vi.fn(),
    sendChat: vi.fn(),
    backlogItems: r.backlogItems,
    runner: createSettingsService({ settings: r.settings, tags: r.tags }),
    runBacklogItem: vi.fn(),
    submitTask,
    modelFor: () => undefined,
    mcpUrl: () => `http://${host}/mcp`,
    publish: (event) => events.push(event),
  });
  app = createApp({ token: "test-token", getPort: () => port, voiceCommands: commands }).app;
});

afterEach(() => {
  commands.shutdown();
  opened.close();
});

/** Starts a voice turn and returns its bearer token. */
async function turnToken(): Promise<string> {
  commands.command(repoId, "create a task");
  await new Promise((resolve) => setImmediate(resolve));
  const header = adapter.calls.at(-1)?.options.permissions.harnessMcp?.headers.Authorization;
  return header?.replace(/^Bearer /, "") ?? "";
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * A minimal MCP client over streamable HTTP (JSON responses), as the CLIs
 * talk to the server. The SDK client cannot load under the test's `source`
 * export condition, which resolves one of its dependencies to raw TypeScript.
 */
async function connect(token: string) {
  let id = 0;
  const send = async (method: string, params?: unknown) => {
    const res = await app.request(`http://${host}/mcp`, {
      method: "POST",
      headers: {
        host,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };
  const init = (await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  })) as { serverInfo: { name: string } };
  expect(init.serverInfo.name).toBe("blackwall");
  return {
    listTools: async () =>
      (await send("tools/list")) as {
        tools: { name: string; inputSchema: Record<string, unknown> }[];
      },
    callTool: async (name: string, args: Record<string, unknown>) =>
      (await send("tools/call", { name, arguments: args })) as ToolResult,
  };
}

const lastVoice = () =>
  events.findLast((e): e is Extract<ServerEvent, { type: "voice.upserted" }> => {
    return e.type === "voice.upserted";
  })?.payload.voice;

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

describe("blackwall MCP server", () => {
  it("refuses requests without a live turn's token", async () => {
    const post = (headers: Record<string, string>) =>
      app.request(`http://${host}/mcp`, {
        method: "POST",
        headers: { host, "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
    const token = await turnToken();
    commands.shutdown();
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("lists the voice tools", async () => {
    const client = await connect(await turnToken());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "create_task",
      "update_task_draft",
      "submit_task_draft",
      "run_backlog_item",
      "set_backlog_runner",
      "show_grid_wall",
      "select_repo",
      "send_chat_message",
      "answer_grill_question",
      "open_task",
      "approve_plan",
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } },
    });
  });

  it("opens a draft and creates its task once", async () => {
    const client = await connect(await turnToken());
    const created = await client.callTool("create_task", {
      title: "Dark mode",
      description: "A toggle",
    });
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toBe("Opened the New task form with 'Dark mode'.");
    expect(lastVoice()?.draft).toMatchObject({
      repoId,
      title: "Dark mode",
      description: "A toggle",
    });

    const submitted = await client.callTool("submit_task_draft", {});
    expect(textOf(submitted)).toBe("Created and started task 'Dark mode'.");
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(lastVoice()).toMatchObject({
      draft: null,
      created: { repoId, taskId: "t1", title: "Dark mode" },
    });

    const again = await client.callTool("submit_task_draft", {});
    expect(again.isError).toBe(true);
    expect(submitTask).toHaveBeenCalledTimes(1);
  });

  it("returns invalid input and tool errors as error results", async () => {
    const client = await connect(await turnToken());
    const invalid = await client.callTool("create_task", { title: 5 });
    expect(invalid.isError).toBe(true);
    const failed = await client.callTool("update_task_draft", {});
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("There is no task draft open");
  });
});
