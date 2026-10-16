import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, ServerEvent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createFakeAdapter, type FakeAdapter, type FakeScript } from "../pipeline/fake-adapter.js";
import { RepoNotFoundError } from "../repos/service.js";
import {
  ChatActionNotFoundError,
  ChatBusyError,
  ChatMessageNotFoundError,
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
let worktree: string;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
  otherRepoId = r.repos.create({ path: "/code/other", name: "other" }).id;
  events = [];
  script = () => ({ structured: { reply: "Hello", actions: [] } });
  adapter = createFakeAdapter("claude", (_options, call) => script(call));
  chat = createService();
  worktree = mkdtempSync(join(tmpdir(), "blackwall-chat-test-"));
});

/** A chat service on the shared database; a second one stands in for a server restart. */
function createService(options: { historyLimit?: number } = {}): ChatService {
  return createChatService({
    adapters: { claude: adapter, copilot: adapter },
    repos: r.repos,
    tasks: r.tasks,
    questions: r.grillQuestions,
    backlogItems: r.backlogItems,
    messages: r.chatMessages,
    modelFor: () => "planner-model",
    publish: (event) => events.push(event),
    ...options,
  });
}

/** Stops the current service and starts a new one, as a restart would. */
function restart(options: { historyLimit?: number } = {}): void {
  chat.shutdown();
  chat = createService(options);
}

afterEach(() => {
  chat.shutdown();
  opened.close();
  rmSync(worktree, { recursive: true, force: true });
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

  it("lets the chat read the repo's reference repos whose folders exist", async () => {
    const lib = r.repos.create({ path: tmpdir(), name: "lib" });
    // "/code/other" does not exist, so it is skipped.
    r.repos.update(repoId, { referenceRepoIds: [lib.id, otherRepoId] });
    chat.send(repoId, "What does lib export?");
    await idle();

    const options = adapter.calls[0]?.options;
    expect(options?.permissions.readDirs).toEqual([tmpdir()]);
    expect(options?.systemPrompt).toContain(`- lib: ${tmpdir()}`);
    expect(options?.systemPrompt).not.toContain("/code/other");
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
    expect(prompt).not.toContain("## Focused task");
  });

  it("gives the task the user is looking at in full", async () => {
    const failed = addTask("Fix login", repoId);
    r.tasks.update(failed.id, {
      status: "failed",
      error: "pnpm install failed: ENOTFOUND",
      plan: "## Plan\nSwap the hash",
    });

    chat.send(repoId, "Why did this fail?", failed.id);
    await idle();
    const prompt = adapter.calls[0]!.options.prompt;
    const focus = prompt.slice(prompt.indexOf("## Focused task"));
    expect(focus).toContain(`- id \`${failed.id}\``);
    expect(focus).toContain("### Error\n\npnpm install failed: ENOTFOUND");
    expect(focus).toContain("### Plan\n\n## Plan\nSwap the hash");
  });

  it("ignores a focused task of another repo, an archived one or an unknown id", async () => {
    const foreign = addTask("Foreign task", otherRepoId);
    const archived = addTask("Old work", repoId);
    r.tasks.update(archived.id, { archivedAt: new Date() });
    for (const id of [foreign.id, archived.id, "nope"]) {
      chat.send(repoId, "Why?", id);
      await idle();
    }
    for (const call of adapter.calls) {
      expect(call.options.prompt).not.toContain("## Focused task");
      expect(call.options.cwd).toBe("/code/app");
    }
  });

  it("runs read-only in the focused task's worktree", async () => {
    const task = addTask("Fix login", repoId);
    r.tasks.update(task.id, { worktreePath: worktree, branch: "agent/fix-login" });

    chat.send(repoId, "Why did the checks fail?", task.id);
    await idle();
    const call = adapter.calls[0]!.options;
    expect(call.cwd).toBe(worktree);
    expect(call.permissions.profile).toBe("read-only");
    expect(call.prompt).toContain(
      `- worktree \`${worktree}\` (the current directory) · branch \`agent/fix-login\` · forked from \`main\``,
    );
  });

  it("runs in the checkout when the focused task has no worktree on disk", async () => {
    const none = addTask("No worktree", repoId);
    const gone = addTask("Removed worktree", repoId);
    r.tasks.update(gone.id, { worktreePath: join(worktree, "missing"), branch: "agent/gone" });
    for (const id of [none.id, gone.id]) {
      chat.send(repoId, "Why?", id);
      await idle();
    }
    for (const call of adapter.calls) {
      expect(call.options.cwd).toBe("/code/app");
      expect(call.options.prompt).toContain("## Focused task");
      expect(call.options.prompt).not.toContain("- worktree");
    }
  });

  it("resumes a session only in the directory it ran in", async () => {
    const task = addTask("Fix login", repoId);
    r.tasks.update(task.id, { worktreePath: worktree, branch: "agent/fix-login" });

    chat.send(repoId, "Hi");
    await idle();
    chat.send(repoId, "Look at the task", task.id);
    await idle();
    chat.send(repoId, "And the diff?", task.id);
    await idle();
    chat.send(repoId, "/clear");
    chat.send(repoId, "Again", task.id);
    await idle();

    const [, moved, same, cleared] = adapter.calls.map((c) => c.options);
    expect(moved?.cwd).toBe(worktree);
    expect(moved?.resumeSessionId).toBeUndefined();
    expect(moved?.prompt).toContain("**User:** Hi");
    expect(same?.resumeSessionId).toBe("fake-2");
    expect(same?.prompt).not.toContain("## Earlier conversation");
    expect(cleared?.resumeSessionId).toBeUndefined();
  });

  it("lists the open questions of a task at the questions gate", async () => {
    const grilled = addTask("Add export", repoId);
    r.tasks.update(grilled.id, { status: "needs-you", stage: "plan-review", gate: "questions" });
    const open = r.grillQuestions.create({ taskId: grilled.id, question: "Zip or tar?" });
    r.grillQuestions.markNeedsHuman(open.id);
    const done = r.grillQuestions.create({ taskId: grilled.id, question: "Which folder?" });
    r.grillQuestions.markNeedsHuman(done.id);
    r.grillQuestions.answer(done.id, "exports/", "user");
    r.grillQuestions.create({ taskId: grilled.id, question: "Planner's to answer" });

    chat.send(repoId, "What should I answer?", grilled.id);
    await idle();
    const prompt = adapter.calls[0]!.options.prompt;
    expect(prompt).toContain(`  - question \`${open.id}\`: Zip or tar?`);
    expect(prompt).toContain(`### Open questions for the user\n\n- \`${open.id}\` Zip or tar?`);
    expect(prompt).not.toContain("Which folder?");
    expect(prompt).not.toContain("Planner's to answer");
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

  it("adds an action to an assistant message, stores it and publishes it", async () => {
    chat.send(repoId, "Hi");
    const [user, assistant] = (await idle()).messages;
    events = [];

    const state = chat.addAction(repoId, assistant!.id, {
      kind: "create-task",
      title: "T",
      description: "D",
    });
    const action = state.messages[1]!.actions[0]!;
    expect(action).toMatchObject({ kind: "create-task", title: "T", description: "D" });
    expect(action.id).toEqual(expect.any(String));
    expect(action.appliedAt).toBeNull();
    expect(events).toEqual([{ type: "chat.upserted", payload: { chat: state } }]);
    expect(r.chatMessages.list(repoId)).toEqual(state.messages);

    restart();
    expect(chat.get(repoId).messages).toEqual(state.messages);
    const applied = chat.markApplied(repoId, action.id);
    expect(applied.messages[1]!.actions[0]!.appliedAt).not.toBeNull();

    const proposal = { kind: "stop-task", taskId: "t1" } as const;
    expect(() => chat.addAction(repoId, "nope", proposal)).toThrow(ChatMessageNotFoundError);
    expect(() => chat.addAction(repoId, user!.id, proposal)).toThrow(ChatMessageNotFoundError);
    expect(() => chat.addAction("nope", assistant!.id, proposal)).toThrow(RepoNotFoundError);
    chat.send(repoId, "/clear");
    expect(() => chat.addAction(repoId, assistant!.id, proposal)).toThrow(ChatMessageNotFoundError);
  });

  it("keeps an action added while a turn runs", async () => {
    chat.send(repoId, "Hi");
    const assistantId = (await idle()).messages[1]!.id;
    script = () => ({ structured: { reply: "Later", actions: [] } });
    chat.send(repoId, "More");
    expect(chat.get(repoId).busy).toBe(true);

    chat.addAction(repoId, assistantId, { kind: "create-task", title: "T", description: "D" });
    const state = await idle();
    expect(state.messages.map((m) => m.text)).toEqual(["Hi", "Hello", "More", "Later"]);
    expect(state.messages[1]!.actions).toMatchObject([{ kind: "create-task", title: "T" }]);
    expect(r.chatMessages.list(repoId)).toEqual(state.messages);
  });

  it("reset aborts running answers and reloads every chat from the database", async () => {
    chat.send(otherRepoId, "Hi");
    await idle(otherRepoId);
    script = () => ({ hang: true });
    chat.send(repoId, "Long question");

    // Stands in for a data import replacing the stored rows.
    r.chatMessages.deleteForRepo(otherRepoId);
    chat.reset();
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.calls[1]!.options.signal?.aborted).toBe(true);
    expect(chat.get(repoId)).toMatchObject({ busy: false });
    expect(chat.get(repoId).messages).toEqual(r.chatMessages.list(repoId));
    expect(chat.get(otherRepoId).messages).toEqual([]);

    // The next message starts a fresh session.
    script = () => ({ structured: { reply: "Fresh", actions: [] } });
    chat.send(otherRepoId, "Again");
    await idle(otherRepoId);
    expect(adapter.calls[2]!.options.resumeSessionId).toBeUndefined();
  });

  it("stores the conversation as it goes", async () => {
    script = () => ({
      structured: { reply: "Done", actions: [{ kind: "resume-task", taskId: "t1" }] },
    });
    chat.send(repoId, "Resume it");
    const state = await idle();
    expect(r.chatMessages.list(repoId)).toEqual(state.messages);
    expect(r.chatMessages.latestSession(repoId)).toEqual({ sessionId: "fake-1", cli: "claude" });
  });

  it("reloads the conversation and resumes its session after a restart", async () => {
    script = () => ({
      structured: { reply: "Ok", actions: [{ kind: "resume-task", taskId: "t1" }] },
    });
    chat.send(repoId, "Resume it");
    const actionId = (await idle()).messages[1]!.actions[0]!.id;
    const applied = chat.markApplied(repoId, actionId);

    restart();
    expect(chat.get(repoId).messages).toEqual(applied.messages);
    expect(chat.get(repoId).messages[1]!.actions[0]!.appliedAt).not.toBeNull();

    chat.send(repoId, "And now?");
    await idle();
    const call = adapter.calls[1]!.options;
    expect(call.resumeSessionId).toBe("fake-1");
    expect(call.prompt).not.toContain("## Earlier conversation");
  });

  it("deletes the stored conversation on /clear", async () => {
    chat.send(repoId, "Hi");
    await idle();
    chat.send(otherRepoId, "Other");
    await idle(otherRepoId);

    script = () => ({ hang: true });
    chat.send(repoId, "Long question");
    chat.send(repoId, "/clear");
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.chatMessages.list(repoId)).toEqual([]);
    expect(r.chatMessages.list(otherRepoId)).toHaveLength(2);

    restart();
    expect(chat.get(repoId).messages).toEqual([]);
    script = () => ({ structured: { reply: "Fresh", actions: [] } });
    chat.send(repoId, "Again");
    await idle();
    expect(adapter.calls.at(-1)!.options.resumeSessionId).toBeUndefined();
    expect(adapter.calls.at(-1)!.options.prompt).not.toContain("## Earlier conversation");
  });

  it("replays the last messages when the session is for another CLI", async () => {
    restart({ historyLimit: 2 });
    script = (call) =>
      call === 1
        ? { fail: "CLI crashed" }
        : { structured: { reply: `Answer ${call}`, actions: [] } };
    chat.send(repoId, "Question 0");
    await idle();
    chat.send(repoId, "Question 1");
    await idle();
    chat.send(repoId, "Question 2");
    await idle();

    r.repos.update(repoId, { defaultCli: "copilot" });
    restart({ historyLimit: 2 });
    chat.send(repoId, "Question 3");
    await idle();
    const call = adapter.calls.at(-1)!.options;
    expect(call.resumeSessionId).toBeUndefined();
    const earlier = call.prompt.slice(
      call.prompt.indexOf("## Earlier conversation"),
      call.prompt.indexOf("## Message"),
    );
    expect(earlier).toContain("**User:** Question 2");
    expect(earlier).toContain("**Assistant:** Answer 2");
    expect(earlier).not.toContain("Question 1");
    expect(earlier).not.toContain("CLI crashed");
    expect(earlier).not.toContain("Question 3");
  });

  it("replays the conversation when a lost session is retried", async () => {
    chat.send(repoId, "First");
    await idle();
    script = (call) =>
      call === 1 ? { missingSession: true } : { structured: { reply: "Back", actions: [] } };
    chat.send(repoId, "Second");
    await idle();
    const [, resumed, retried] = adapter.calls.map((c) => c.options.prompt);
    expect(resumed).not.toContain("## Earlier conversation");
    expect(retried).toContain("**User:** First");
    expect(retried).toContain("**Assistant:** Hello");
    expect(retried).not.toContain("**User:** Second");
  });

  it("throws for an unknown repo", () => {
    expect(() => chat.get("missing")).toThrow(RepoNotFoundError);
    expect(() => chat.send("missing", "Hi")).toThrow(RepoNotFoundError);
  });
});
