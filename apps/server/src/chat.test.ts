import {
  ChatActionNotFoundError,
  ChatBusyError,
  ChatMessageNotFoundError,
  RepoNotFoundError,
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

function state(repoId: string): ChatState {
  return { repoId, busy, activity: null, messages: [] };
}

function known(repoId: string) {
  if (repoId !== "r1") throw new RepoNotFoundError(repoId);
}

beforeEach(() => {
  busy = false;
  chat = {
    get: vi.fn((repoId: string) => {
      known(repoId);
      return state(repoId);
    }),
    send: vi.fn((repoId: string, text: string) => {
      known(repoId);
      if (busy && text.trim() !== "/clear") throw new ChatBusyError();
      return state(repoId);
    }),
    markApplied: vi.fn((repoId: string, actionId: string) => {
      known(repoId);
      if (actionId !== "a1") throw new ChatActionNotFoundError(actionId);
      return state(repoId);
    }),
    addAction: vi.fn((repoId: string, messageId: string) => {
      known(repoId);
      if (messageId !== "m1") throw new ChatMessageNotFoundError(messageId);
      return state(repoId);
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
    expect((await request("nope/chat")).status).toBe(404);
  });

  it("accepts a message for the background answer", async () => {
    const res = await request("r1/chat", { method: "POST", body: { text: " Hi " } });
    expect(res.status).toBe(202);
    expect(chat.send).toHaveBeenCalledWith("r1", "Hi", undefined);
  });

  it("forwards the task the user is looking at", async () => {
    const res = await request("r1/chat", { method: "POST", body: { text: "Why?", taskId: "t1" } });
    expect(res.status).toBe(202);
    expect(chat.send).toHaveBeenCalledWith("r1", "Why?", "t1");
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
    expect(chat.markApplied).toHaveBeenCalledWith("r1", "a1");
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
    expect(chat.addAction).toHaveBeenCalledWith("r1", "m1", {
      kind: "create-task",
      title: "Fix it",
      description: "Why",
    });

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
