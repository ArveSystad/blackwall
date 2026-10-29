import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatState, ServerEvent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import type {
  AgentAdapter,
  AgentEvent,
  AgentResult,
  AgentRunOptions,
} from "../agents/adapters/types.js";
import { emptyUsage } from "../agents/adapters/types.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { TaskNotFoundError } from "../pipeline/engine.js";
import { createFakeAdapter, type FakeAdapter, type FakeScript } from "../pipeline/fake-adapter.js";
import { RepoNotFoundError } from "../repos/service.js";
import {
  CHAT_DRAFT_THROTTLE_MS,
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
function createService({
  cli = adapter,
  ...options
}: { historyLimit?: number; cli?: AgentAdapter } = {}): ChatService {
  return createChatService({
    adapters: { claude: cli, copilot: cli },
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

/** Resolves once the repo's chat, or the task's when `taskId` is given, is idle again. */
async function idle(id = repoId, taskId?: string): Promise<ChatState> {
  for (let i = 0; i < 100 && chat.get(id, taskId).busy; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return chat.get(id, taskId);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

/** A run the test drives: it streams what the test emits and ends when the test finishes it. */
interface DrivenRun {
  options: AgentRunOptions;
  emit: (event: AgentEvent) => void;
  finish: (structured: unknown) => void;
}

/** An adapter whose runs the test drives event by event. */
function drivenAdapter(): { adapter: AgentAdapter; runs: DrivenRun[] } {
  const runs: DrivenRun[] = [];
  const adapter: AgentAdapter = {
    cli: "claude",
    run(options) {
      const queue: AgentEvent[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let resolve: (result: AgentResult) => void = () => undefined;
      const result = new Promise<AgentResult>((res) => (resolve = res));
      runs.push({
        options,
        emit(event) {
          queue.push(event);
          wake?.();
        },
        finish(structured) {
          resolve({ sessionId: "driven", text: "", structured, usage: emptyUsage() });
          done = true;
          wake?.();
        },
      });
      return {
        result,
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const event = queue.shift();
            if (event) {
              yield event;
              continue;
            }
            if (done) return;
            await new Promise<void>((res) => (wake = res));
            wake = undefined;
          }
        },
      };
    },
  };
  return { adapter, runs };
}

/** The drafts published so far, in order. */
const drafts = () =>
  events.flatMap((e) => (e.type === "chat.upserted" ? [e.payload.chat.draft] : []));

describe("chat service drafts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const partial = (json: string): AgentEvent => ({ type: "partial", text: json, json: true });

  it("publishes the streamed reply as a throttled draft, then the final reply", async () => {
    const { adapter: driven, runs } = drivenAdapter();
    chat = createService({ cli: driven });
    chat.send(repoId, "Hi");
    const run = runs[0]!;
    expect(run.options.streamPartial).toBe(true);

    run.emit(partial('{"reply":"Hel'));
    await tick();
    expect(chat.get(repoId).draft).toBe("Hel");
    run.emit(partial('{"reply":"Hello'));
    run.emit(partial('{"reply":"Hello wor'));
    await tick();
    // Throttled: the newer drafts wait for the next slot.
    expect(chat.get(repoId).draft).toBe("Hel");
    vi.advanceTimersByTime(CHAT_DRAFT_THROTTLE_MS);
    expect(chat.get(repoId).draft).toBe("Hello wor");
    expect(drafts().filter((d) => d !== null)).toEqual(["Hel", "Hello wor"]);

    run.emit(partial('{"reply":"Hello world"'));
    await tick();
    run.finish({ reply: "Hello world", actions: [] });
    const state = await idle();
    expect(state.draft).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello world" });
    // The pending draft never goes out after the final reply.
    vi.advanceTimersByTime(CHAT_DRAFT_THROTTLE_MS);
    expect(drafts().at(-1)).toBeNull();
    expect(chat.get(repoId).draft).toBeNull();
  });

  it("drops the draft when a top-level tool call starts, but not a sub-agent's", async () => {
    const { adapter: driven, runs } = drivenAdapter();
    chat = createService({ cli: driven });
    chat.send(repoId, "Hi");
    const run = runs[0]!;
    run.emit({ type: "partial", text: "Let me look.", json: false });
    await tick();
    expect(chat.get(repoId).draft).toBe("Let me look.");
    run.emit({ type: "tool-call-start", id: "t1", name: "Read", input: {}, parentId: "a1" });
    await tick();
    expect(chat.get(repoId).draft).toBe("Let me look.");
    run.emit({ type: "tool-call-start", id: "t2", name: "Grep", input: { pattern: "x" } });
    await tick();
    expect(chat.get(repoId)).toMatchObject({ draft: null, activity: "Grep · x" });
    run.finish({ reply: "Found it", actions: [] });
    await idle();
  });

  it("clears the draft on /clear and drops the old turn's late partials", async () => {
    const { adapter: driven, runs } = drivenAdapter();
    chat = createService({ cli: driven });
    chat.send(repoId, "Hi");
    const run = runs[0]!;
    run.emit(partial('{"reply":"Hel'));
    await tick();
    run.emit(partial('{"reply":"Hello'));
    await tick();

    expect(chat.send(repoId, "/clear")).toMatchObject({ draft: null, messages: [] });
    run.emit(partial('{"reply":"Hello there'));
    await tick();
    vi.advanceTimersByTime(CHAT_DRAFT_THROTTLE_MS * 2);
    run.finish({ reply: "Hello there", actions: [] });
    await tick();
    expect(chat.get(repoId)).toMatchObject({ draft: null, messages: [] });
    expect(drafts().at(-1)).toBeNull();
  });
});

describe("chat service", () => {
  it("starts a read-only session in the checkout, then resumes it", async () => {
    chat.send(repoId, "What does this repo do?");
    const first = await idle();
    expect(first.draft).toBeNull();
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

  it("reads the task's own reference repos in its chat, not the repo's", async () => {
    const lib = r.repos.create({ path: tmpdir(), name: "lib" });
    const docs = r.repos.create({ path: worktree, name: "docs" });
    r.repos.update(repoId, { referenceRepoIds: [lib.id] });
    const task = r.tasks.create({
      title: "Write guide",
      origin: { kind: "free-text" },
      repoId,
      freeText: "Do Write guide",
      agents: {},
      status: "running",
      referenceRepoIds: [docs.id],
    });
    const bare = addTask("No refs", repoId);

    chat.send(repoId, "What does docs say?", task.id);
    await idle(repoId, task.id);
    const inTask = adapter.calls[0]?.options;
    expect(inTask?.permissions.readDirs).toEqual([worktree]);
    expect(inTask?.systemPrompt).toContain(`- docs: ${worktree}`);
    expect(inTask?.systemPrompt).not.toContain("- lib:");

    chat.send(repoId, "And lib?");
    await idle();
    expect(adapter.calls[1]?.options.permissions.readDirs).toEqual([tmpdir()]);

    // A task without reference repos reads none, even though the repo has some.
    chat.send(repoId, "Anything?", bare.id);
    await idle(repoId, bare.id);
    expect(adapter.calls[2]?.options.permissions.readDirs).toEqual([]);
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

  it("gives the task in full in its own chat", async () => {
    const failed = addTask("Fix login", repoId);
    r.tasks.update(failed.id, {
      status: "failed",
      error: "pnpm install failed: ENOTFOUND",
      plan: "## Plan\nSwap the hash",
    });

    chat.send(repoId, "Why did this fail?", failed.id);
    await idle(repoId, failed.id);
    const prompt = adapter.calls[0]!.options.prompt;
    const focus = prompt.slice(prompt.indexOf("## Focused task"));
    expect(focus).toContain("This conversation is about this task");
    expect(focus).toContain(`- id \`${failed.id}\``);
    expect(focus).toContain("### Error\n\npnpm install failed: ENOTFOUND");
    expect(focus).toContain("### Plan\n\n## Plan\nSwap the hash");
  });

  it("keeps a task's chat apart from the repo's and publishes it with the task id", async () => {
    const task = addTask("Fix login", repoId);
    chat.send(repoId, "Repo question");
    await idle();
    events = [];
    chat.send(repoId, "Task question", task.id);
    const state = await idle(repoId, task.id);

    expect(state.taskId).toBe(task.id);
    expect(state.messages.map((m) => m.text)).toEqual(["Task question", "Hello"]);
    expect(chat.get(repoId).taskId).toBeNull();
    expect(chat.get(repoId).messages.map((m) => m.text)).toEqual(["Repo question", "Hello"]);
    expect(r.chatMessages.list(repoId, task.id)).toEqual(state.messages);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(
      events.every((e) => e.type === "chat.upserted" && e.payload.chat.taskId === task.id),
    ).toBe(true);
    // The task chat's turn carries no repo chat history and starts its own session.
    expect(adapter.calls[1]!.options.resumeSessionId).toBeUndefined();
    expect(adapter.calls[1]!.options.prompt).not.toContain("Repo question");
  });

  it("never focuses a task in the repo's chat", async () => {
    const task = addTask("Fix login", repoId);
    r.tasks.update(task.id, { worktreePath: worktree, branch: "agent/fix-login" });
    chat.send(repoId, "Why?");
    await idle();
    const call = adapter.calls[0]!.options;
    expect(call.prompt).not.toContain("## Focused task");
    expect(call.cwd).toBe("/code/app");
  });

  it("focuses an archived task in its own chat", async () => {
    const archived = addTask("Old work", repoId);
    r.tasks.update(archived.id, { archivedAt: new Date() });
    chat.send(repoId, "What happened here?", archived.id);
    await idle(repoId, archived.id);
    const prompt = adapter.calls[0]!.options.prompt;
    expect(prompt.slice(prompt.indexOf("## Focused task"))).toContain(`- id \`${archived.id}\``);
  });

  it("refuses a task of another repo or an unknown task", () => {
    const foreign = addTask("Foreign task", otherRepoId);
    for (const id of [foreign.id, "nope"]) {
      expect(() => chat.get(repoId, id)).toThrow(TaskNotFoundError);
      expect(() => chat.send(repoId, "Why?", id)).toThrow(TaskNotFoundError);
      expect(() => chat.markApplied(repoId, "a1", id)).toThrow(TaskNotFoundError);
      expect(() => chat.addAction(repoId, "m1", { kind: "stop-task", taskId: "t1" }, id)).toThrow(
        TaskNotFoundError,
      );
    }
    expect(adapter.calls).toEqual([]);
    expect(r.chatMessages.list(repoId, null)).toEqual([]);
  });

  it("runs read-only in the task's worktree", async () => {
    const task = addTask("Fix login", repoId);
    r.tasks.update(task.id, { worktreePath: worktree, branch: "agent/fix-login" });

    chat.send(repoId, "Why did the checks fail?", task.id);
    await idle(repoId, task.id);
    const call = adapter.calls[0]!.options;
    expect(call.cwd).toBe(worktree);
    expect(call.permissions.profile).toBe("read-only");
    expect(call.prompt).toContain(
      `- worktree \`${worktree}\` (the current directory) · branch \`agent/fix-login\` · forked from \`main\``,
    );
  });

  it("runs in the checkout when the task has no worktree on disk", async () => {
    const none = addTask("No worktree", repoId);
    const gone = addTask("Removed worktree", repoId);
    r.tasks.update(gone.id, { worktreePath: join(worktree, "missing"), branch: "agent/gone" });
    for (const id of [none.id, gone.id]) {
      chat.send(repoId, "Why?", id);
      await idle(repoId, id);
    }
    for (const call of adapter.calls) {
      expect(call.options.cwd).toBe("/code/app");
      expect(call.options.prompt).toContain("## Focused task");
      expect(call.options.prompt).not.toContain("- worktree");
    }
  });

  it("resumes each conversation's own session", async () => {
    const task = addTask("Fix login", repoId);
    r.tasks.update(task.id, { worktreePath: worktree, branch: "agent/fix-login" });

    chat.send(repoId, "Hi");
    await idle();
    chat.send(repoId, "Look at the task", task.id);
    await idle(repoId, task.id);
    chat.send(repoId, "And the diff?", task.id);
    await idle(repoId, task.id);
    chat.send(repoId, "Back to the repo");
    await idle();

    const [, task1, task2, repo2] = adapter.calls.map((c) => c.options);
    expect(task1?.cwd).toBe(worktree);
    expect(task1?.resumeSessionId).toBeUndefined();
    expect(task2?.resumeSessionId).toBe("fake-2");
    expect(task2?.prompt).not.toContain("## Earlier conversation");
    expect(repo2?.cwd).toBe("/code/app");
    expect(repo2?.resumeSessionId).toBe("fake-1");

    restart();
    chat.send(repoId, "After a restart", task.id);
    await idle(repoId, task.id);
    expect(adapter.calls.at(-1)!.options.resumeSessionId).toBe("fake-2");
  });

  it("clears only the task's chat on /clear there", async () => {
    const task = addTask("Fix login", repoId);
    chat.send(repoId, "Repo question");
    await idle();
    chat.send(repoId, "Task question", task.id);
    await idle(repoId, task.id);

    chat.send(repoId, "/clear", task.id);
    expect(chat.get(repoId, task.id).messages).toEqual([]);
    expect(r.chatMessages.list(repoId, task.id)).toEqual([]);
    expect(chat.get(repoId).messages).toHaveLength(2);
    expect(r.chatMessages.list(repoId, null)).toHaveLength(2);
  });

  it("answers in the repo's chat and a task's at the same time", async () => {
    const task = addTask("Fix login", repoId);
    script = () => ({ hang: true });
    chat.send(repoId, "Long repo question");
    chat.send(repoId, "Long task question", task.id);
    expect(chat.get(repoId).busy).toBe(true);
    expect(chat.get(repoId, task.id).busy).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  it("forgetTask ends the task's turn and waits for its run before returning", async () => {
    const task = addTask("Fix login", repoId);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Like a CLI that takes a while to exit after the kill.
    const slow: AgentAdapter = {
      cli: "claude",
      run(options) {
        const run = adapter.run(options);
        return {
          result: run.result.finally(() => released),
          [Symbol.asyncIterator]: () => run[Symbol.asyncIterator](),
        };
      },
    };
    chat.shutdown();
    chat = createService({ cli: slow });
    script = () => ({ hang: true });
    chat.send(repoId, "Long question", task.id);
    chat.send(repoId, "Repo question");

    let forgotten = false;
    const forgetting = chat.forgetTask(task.id).then(() => (forgotten = true));
    for (let i = 0; i < 5; i++) await tick();
    expect(adapter.calls[0]!.options.signal?.aborted).toBe(true);
    expect(adapter.calls[1]!.options.signal?.aborted).toBe(false);
    expect(forgotten).toBe(false);

    release();
    await forgetting;
    expect(r.chatMessages.list(repoId, task.id).map((m) => m.role)).toEqual(["user"]);
    expect(() => chat.send(repoId, "Again", task.id)).toThrow(TaskNotFoundError);
    expect(() => chat.get(repoId, task.id)).toThrow(TaskNotFoundError);
    expect(chat.get(repoId).busy).toBe(true);
  });

  it("forgetTask is a no-op for a task without a chat", async () => {
    const task = addTask("Fix login", repoId);
    await chat.forgetTask(task.id);
    expect(() => chat.get(repoId, task.id)).toThrow(TaskNotFoundError);
    chat.reset();
    expect(chat.get(repoId, task.id).messages).toEqual([]);
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
    await idle(repoId, grilled.id);
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
    expect(cleared).toMatchObject({ busy: false, activity: null, draft: null, messages: [] });
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
    expect(r.chatMessages.list(repoId, null)).toEqual(state.messages);

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
    expect(r.chatMessages.list(repoId, null)).toEqual(state.messages);
  });

  it("reset aborts running answers and reloads every chat from the database", async () => {
    chat.send(otherRepoId, "Hi");
    await idle(otherRepoId);
    script = () => ({ hang: true });
    chat.send(repoId, "Long question");

    // Stands in for a data import replacing the stored rows.
    r.chatMessages.deleteConversation(otherRepoId, null);
    chat.reset();
    await new Promise((resolve) => setImmediate(resolve));
    expect(adapter.calls[1]!.options.signal?.aborted).toBe(true);
    expect(chat.get(repoId)).toMatchObject({ busy: false });
    expect(chat.get(repoId).messages).toEqual(r.chatMessages.list(repoId, null));
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
    expect(r.chatMessages.list(repoId, null)).toEqual(state.messages);
    expect(r.chatMessages.latestSession(repoId, null)).toEqual({
      sessionId: "fake-1",
      cli: "claude",
    });
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
    expect(r.chatMessages.list(repoId, null)).toEqual([]);
    expect(r.chatMessages.list(otherRepoId, null)).toHaveLength(2);

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
