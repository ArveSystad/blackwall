import {
  ChatActionNotFoundError,
  ChatBusyError,
  ChatMessageNotFoundError,
  RepoNotFoundError,
  TaskNotFoundError,
} from "@blackwall/core";
import { MAX_TITLE_CHARS, chatStateSchema, type ChatState } from "@blackwall/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import type { ChatRouteService } from "./chat.js";

const port = 4711;
const host = `127.0.0.1:${port}`;
let busy: boolean;
let chat: { [K in keyof ChatRouteService]: ReturnType<typeof vi.fn<ChatRouteService[K]>> };

function state(repoId: string, taskId?: string): ChatState {
  return { repoId, taskId: taskId ?? null, busy, activity: null, draft: null, messages: [] };
}

function known(repoId: string, taskId?: string) {
  if (repoId !== "r1") throw new RepoNotFoundError(repoId);
  if (taskId !== undefined && taskId !== "t1") throw new TaskNotFoundError(taskId);
}

beforeEach(() => {
  busy = false;
  chat = {
    get: vi.fn((repoId: string, taskId?: string) => {
      known(repoId, taskId);
      return state(repoId, taskId);
    }),
    send: vi.fn((repoId: string, text: string, taskId?: string) => {
      known(repoId, taskId);
      if (busy && text.trim() !== "/clear") throw new ChatBusyError();
      return state(repoId, taskId);
    }),
    markApplied: vi.fn((repoId: string, actionId: string, taskId?: string) => {
      known(repoId, taskId);
      if (actionId !== "a1") throw new ChatActionNotFoundError(actionId);
      return state(repoId, taskId);
    }),
    addAction: vi.fn((repoId: string, messageId: string, _proposal, taskId?: string) => {
      known(repoId, taskId);
      if (messageId !== "m1") throw new ChatMessageNotFoundError(messageId);
      return state(repoId, taskId);
    }),
  };
});

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  const app = createApp({ token: "test-token", getPort: () => port, chat }).app;
  return app.request(`http://${host}/api/repos/${path}`, {
    method: init.method ?? "GET",
    headers: {
      host,
      cookie: `${tokenCookieName(port)}=test-token`,
      "content-type": "application/json",
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe("chat routes", () => {
  it("serves a repo's chat", async () => {
    const res = await request("r1/chat");
    expect(res.status).toBe(200);
    expect(chatStateSchema.parse(await res.json())).toEqual(state("r1"));
    expect(chat.get).toHaveBeenCalledWith("r1", undefined);
    expect((await request("nope/chat")).status).toBe(404);
  });

  it("serves a task's own chat at the task mount", async () => {
    const res = await request("r1/tasks/t1/chat");
    expect(res.status).toBe(200);
    expect(chatStateSchema.parse(await res.json())).toEqual(state("r1", "t1"));
    expect(chat.get).toHaveBeenCalledWith("r1", "t1");
    expect((await request("r1/tasks/nope/chat")).status).toBe(404);
  });

  it("accepts a message for the background answer", async () => {
    const res = await request("r1/chat", { method: "POST", body: { text: " Hi " } });
    expect(res.status).toBe(202);
    expect(chat.send).toHaveBeenCalledWith("r1", "Hi", undefined);
  });

  it("sends to the task's chat from the URL, and ignores a task id in the body", async () => {
    const res = await request("r1/tasks/t1/chat", { method: "POST", body: { text: "Why?" } });
    expect(res.status).toBe(202);
    expect(chat.send).toHaveBeenCalledWith("r1", "Why?", "t1");

    await request("r1/chat", { method: "POST", body: { text: "Hi", taskId: "t1" } });
    expect(chat.send).toHaveBeenLastCalledWith("r1", "Hi", undefined);
    expect(
      (await request("r1/tasks/nope/chat", { method: "POST", body: { text: "Hi" } })).status,
    ).toBe(404);
  });

  it("marks applied and adds actions in a task's chat", async () => {
    expect((await request("r1/tasks/t1/chat/actions/a1/applied", { method: "POST" })).status).toBe(
      200,
    );
    expect(chat.markApplied).toHaveBeenCalledWith("r1", "a1", "t1");
    const proposal = { kind: "create-task", title: "T", description: "D" };
    const res = await request("r1/tasks/t1/chat/messages/m1/actions", {
      method: "POST",
      body: proposal,
    });
    expect(res.status).toBe(200);
    expect(chat.addAction).toHaveBeenCalledWith("r1", "m1", proposal, "t1");
  });

  it("rejects empty text, unknown repos and messages while answering, but not /clear", async () => {
    expect((await request("r1/chat", { method: "POST", body: { text: "  " } })).status).toBe(400);
    expect((await request("r1/chat", { method: "POST", body: {} })).status).toBe(400);
    expect((await request("nope/chat", { method: "POST", body: { text: "Hi" } })).status).toBe(404);
    busy = true;
    expect((await request("r1/chat", { method: "POST", body: { text: "Hi" } })).status).toBe(409);
    expect((await request("r1/chat", { method: "POST", body: { text: "/clear" } })).status).toBe(
      202,
    );
  });

  it("marks an action applied", async () => {
    const res = await request("r1/chat/actions/a1/applied", { method: "POST" });
    expect(res.status).toBe(200);
    expect(chat.markApplied).toHaveBeenCalledWith("r1", "a1", undefined);
    expect((await request("r1/chat/actions/zz/applied", { method: "POST" })).status).toBe(404);
    expect((await request("nope/chat/actions/a1/applied", { method: "POST" })).status).toBe(404);
  });

  it("adds an action to a message", async () => {
    const path = "r1/chat/messages/m1/actions";
    const post = (to: string, body?: unknown) =>
      request(to, { method: "POST", ...(body !== undefined ? { body } : {}) });
    const res = await post(path, { kind: "create-task", title: " Fix it ", description: " Why " });
    expect(res.status).toBe(200);
    expect(chatStateSchema.parse(await res.json())).toEqual(state("r1"));
    expect(chat.addAction).toHaveBeenCalledWith(
      "r1",
      "m1",
      { kind: "create-task", title: "Fix it", description: "Why" },
      undefined,
    );

    const valid = { kind: "create-task", title: "T", description: "D" };
    expect((await post(path, { ...valid, title: "  " })).status).toBe(400);
    expect((await post(path, { ...valid, title: "x".repeat(MAX_TITLE_CHARS + 1) })).status).toBe(
      400,
    );
    expect((await post(path)).status).toBe(400);
    expect((await post(path, { ...valid, kind: "delete-repo" })).status).toBe(400);
    expect((await post("r1/chat/messages/zz/actions", valid)).status).toBe(404);
    expect((await post("nope/chat/messages/m1/actions", valid)).status).toBe(404);
  });
});
