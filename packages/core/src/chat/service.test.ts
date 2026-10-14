import type { ChatState, ServerEvent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createFakeAdapter, type FakeAdapter, type FakeScript } from "../pipeline/fake-adapter.js";
import { RepoNotFoundError } from "../repos/service.js";
import {
  ChatActionNotFoundError,
  ChatBusyError,
  createChatService,
  type ChatService,
} from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let repoId: string;
let otherRepoId: string;
let events: ServerEvent[];
let adapter: FakeAdapter;
let chat: ChatService;
let script: (call: number) => FakeScript;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
  otherRepoId = r.repos.create({ path: "/code/other", name: "other" }).id;
  events = [];
  script = () => ({ structured: { reply: "Hello", actions: [] } });
  adapter = createFakeAdapter("claude", (_options, call) => script(call));
  chat = createChatService({
    adapters: { claude: adapter },
    repos: r.repos,
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    modelFor: () => "planner-model",
    publish: (event) => events.push(event),
  });
});

afterEach(() => {
  chat.shutdown();
  opened.close();
});

/** Resolves once the repo's chat is idle again. */
async function idle(id = repoId): Promise<ChatState> {
  for (let i = 0; i < 100 && chat.get(id).busy; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return chat.get(id);
}

function addTask(title: string, repo: string) {
  return r.tasks.create({
    title,
    origin: { kind: "free-text" },
    repoId: repo,
    freeText: `Do ${title}`,
    agents: {},
    status: "running",
  });
}

describe("chat service", () => {
  it("starts a read-only session in the checkout, then resumes it", async () => {
    chat.send(repoId, "What does this repo do?");
    const first = await idle();
    expect(first.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What does this repo do?"],
      ["assistant", "Hello"],
    ]);
    chat.send(repoId, "And the tests?");
    await idle();

    const [one, two] = adapter.calls.map((c) => c.options);
    expect(one).toMatchObject({ cwd: "/code/app", model: "planner-model" });
    expect(one?.permissions.profile).toBe("read-only");
    expect(one?.jsonSchema).toBeDefined();
    expect(one?.systemPrompt).toContain("## Actions contract");
    expect(one?.resumeSessionId).toBeUndefined();
    expect(two?.resumeSessionId).toBe("fake-1");
  });

  it("lists only this repo's unarchived tasks and backlog in the prompt", async () => {
    const mine = addTask("Add dark mode", repoId);
    const archived = addTask("Old work", repoId);
    r.tasks.update(archived.id, { archivedAt: new Date() });
    addTask("Foreign task", otherRepoId);
    r.backlogItems.insert({
      repoId,
      title: "Write docs",
      origin: { kind: "free-text" },
      freeText: "Document the API",
    });
    r.backlogItems.insert({
      repoId: otherRepoId,
      title: "Foreign item",
      origin: { kind: "free-text" },
      freeText: "x",
    });

    chat.send(repoId, "What is going on?");
    await idle();
    const prompt = adapter.calls[0]!.options.prompt;
    expect(prompt).toContain("## Blackwall state");
    expect(prompt).toContain(`\`${mine.id}\` Add dark mode`);
    expect(prompt).toContain("Write docs");
    expect(prompt).toContain("Document the API");
    expect(prompt).not.toContain("Old work");
    expect(prompt).not.toContain("Foreign");
    expect(prompt.endsWith("What is going on?")).toBe(true);
  });

  it("stores proposed actions with their own ids, unapplied, and keeps message ids stable", async () => {
    script = () => ({
      structured: {
        reply: "Here you go",
        actions: [
          { kind: "create-task", title: "Add tests", description: "Cover the parser" },
          { kind: "stop-task", taskId: "t1" },
        ],
      },
    });
    chat.send(repoId, "Plan it");
    const state = await idle();
    const reply = state.messages[1]!;
    expect(reply.actions).toMatchObject([
      { kind: "create-task", title: "Add tests", appliedAt: null },
      { kind: "stop-task", taskId: "t1", appliedAt: null },
    ]);
    const ids = reply.actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(2);

    const published = events.flatMap((e) => (e.type === "chat.upserted" ? [e.payload.chat] : []));
    const userIds = new Set(published.flatMap((s) => s.messages.slice(0, 1).map((m) => m.id)));
    expect(userIds.size).toBe(1);
    expect(published.at(-1)).toEqual(state);
  });

  it("falls back to the text when the structured output is missing or invalid", async () => {
    script = () => ({ text: "Plain answer", structured: { reply: 3 } });
    chat.send(repoId, "Hi");
    const state = await idle();
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      text: "Plain answer",
      actions: [],
    });
  });

  it("refuses a message while answering, but /clear aborts and drops the late result", async () => {
    script = () => ({ hang: true });
    chat.send(repoId, "Long question");
    expect(chat.get(repoId).busy).toBe(true);
    expect(() => chat.send(repoId, "Another")).toThrow(ChatBusyError);

    const cleared = chat.send(repoId, " /clear ");
    expect(cleared).toMatchObject({ busy: false, activity: null, messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(chat.get(repoId).messages).toEqual([]);
    expect(adapter.calls[0]!.options.signal?.aborted).toBe(true);

    // A fresh session after the clear.
    script = () => ({ structured: { reply: "Fresh", actions: [] } });
    chat.send(repoId, "Again");
    await idle();
    expect(adapter.calls[1]!.options.resumeSessionId).toBeUndefined();
  });

  it("retries a lost session once without resuming", async () => {
    chat.send(repoId, "First");
    await idle();
    script = (call) =>
      call === 1 ? { missingSession: true } : { structured: { reply: "Back", actions: [] } };
    chat.send(repoId, "Second");
    const state = await idle();
    expect(adapter.calls.map((c) => c.options.resumeSessionId)).toEqual([
      undefined,
      "fake-1",
      undefined,
    ]);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Back" });
  });

  it("turns a failure or a usage limit into an error message", async () => {
    script = () => ({ fail: "CLI crashed" });
    chat.send(repoId, "Hi");
    let state = await idle();
    expect(state.messages.at(-1)).toMatchObject({ role: "error", text: "CLI crashed" });

    script = () => ({ rateLimit: { resetsAt: "2026-10-14T12:00:00.000Z" } });
    chat.send(repoId, "Hi again");
    state = await idle();
    expect(state.messages.at(-1)?.role).toBe("error");
    expect(state.messages.at(-1)?.text).toContain("usage limit until 2026-10-14T12:00:00.000Z");
    expect(state.busy).toBe(false);
  });

  it("publishes chat.upserted for the repo", async () => {
    chat.send(repoId, "Hi");
    await idle();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.every((e) => e.type === "chat.upserted" && e.payload.chat.repoId === repoId),
    ).toBe(true);
  });

  it("marks an action applied once, and refuses unknown or cleared actions", async () => {
    script = () => ({
      structured: { reply: "Ok", actions: [{ kind: "resume-task", taskId: "t1" }] },
    });
    chat.send(repoId, "Resume it");
    const actionId = (await idle()).messages[1]!.actions[0]!.id;
    events = [];

    const applied = chat.markApplied(repoId, actionId);
    const appliedAt = applied.messages[1]!.actions[0]!.appliedAt;
    expect(appliedAt).not.toBeNull();
    expect(events).toEqual([{ type: "chat.upserted", payload: { chat: applied } }]);

    const again = chat.markApplied(repoId, actionId);
    expect(again.messages[1]!.actions[0]!.appliedAt).toBe(appliedAt);

    expect(() => chat.markApplied(repoId, "nope")).toThrow(ChatActionNotFoundError);
    chat.send(repoId, "/clear");
    expect(() => chat.markApplied(repoId, actionId)).toThrow(ChatActionNotFoundError);
  });

  it("reset aborts running answers and forgets every chat", async () => {
    chat.send(otherRepoId, "Hi");
    await idle(otherRepoId);
    script = () => ({ hang: true });
    chat.send(repoId, "Long question");

    chat.reset();
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.calls[1]!.options.signal?.aborted).toBe(true);
    expect(chat.get(repoId)).toMatchObject({ busy: false, messages: [] });
    expect(chat.get(otherRepoId).messages).toEqual([]);

    // The next message starts a fresh session.
    script = () => ({ structured: { reply: "Fresh", actions: [] } });
    chat.send(otherRepoId, "Again");
    await idle(otherRepoId);
    expect(adapter.calls[2]!.options.resumeSessionId).toBeUndefined();
  });

  it("throws for an unknown repo", () => {
    expect(() => chat.get("missing")).toThrow(RepoNotFoundError);
    expect(() => chat.send("missing", "Hi")).toThrow(RepoNotFoundError);
  });
});
