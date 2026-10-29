import type {
  BacklogItem,
  ChatState,
  GrillAnswerResult,
  NewBacklogItemInput,
  ServerEvent,
  Task,
  VoiceState,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createFakeAdapter, type FakeAdapter, type FakeScript } from "../pipeline/fake-adapter.js";
import { RepoNotFoundError } from "../repos/service.js";
import { createSettingsService, type SettingsService } from "../settings/service.js";
import {
  createVoiceCommandService,
  VoiceBusyError,
  VoiceDraftConflictError,
  type VoiceCommandService,
  type VoiceTurnAccess,
} from "./commands.js";
import { VOICE_TOOL_NAMES, VoiceToolError } from "./tools.js";

let opened: OpenedDatabase;
let r: Repositories;
let settings: SettingsService;
let repoId: string;
let otherRepoId: string;
let events: ServerEvent[];
let adapter: FakeAdapter;
let script: (call: number) => FakeScript;
let submitTask: ReturnType<
  typeof vi.fn<(repoId: string, input: NewBacklogItemInput) => Promise<BacklogItem>>
>;
let runBacklogItem: ReturnType<typeof vi.fn<(repoId: string, itemId: string) => Task>>;
let answerQuestion: ReturnType<
  typeof vi.fn<(taskId: string, questionId: string, answer: string) => Promise<GrillAnswerResult>>
>;
let approvePlan: ReturnType<typeof vi.fn<(taskId: string) => Promise<Task>>>;
let sendChat: ReturnType<
  typeof vi.fn<(repoId: string, text: string, taskId?: string) => ChatState>
>;
let voice: VoiceCommandService;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  settings = createSettingsService({ settings: r.settings, tags: r.tags });
  repoId = r.repos.create({ path: "/code/app", name: "app" }).id;
  otherRepoId = r.repos.create({ path: "/code/other", name: "other" }).id;
  events = [];
  script = () => ({ text: "Done." });
  adapter = createFakeAdapter("claude", (_options, call) => script(call));
  submitTask = vi.fn(async (id: string, input: NewBacklogItemInput) =>
    r.backlogItems.insert({
      repoId: id,
      title: input.title ?? "Untitled",
      origin: { kind: "free-text" },
      freeText: input.freeText ?? "",
    }),
  );
  runBacklogItem = vi.fn(() => ({ id: "t1" }) as Task);
  answerQuestion = vi.fn(async (taskId: string, questionId: string, answer: string) => ({
    question: r.grillQuestions.answer(questionId, answer, "user"),
    task: r.tasks.get(taskId)!,
  }));
  approvePlan = vi.fn(async (taskId: string) => r.tasks.get(taskId)!);
  sendChat = vi.fn((id: string, _text: string, taskId?: string): ChatState => ({
    repoId: id,
    taskId: taskId ?? null,
    busy: true,
    activity: null,
    draft: null,
    messages: [],
  }));
  voice = createVoiceCommandService({
    adapters: { claude: adapter },
    repos: r.repos,
    tasks: r.tasks,
    questions: r.grillQuestions,
    answerQuestion,
    approvePlan,
    sendChat,
    backlogItems: r.backlogItems,
    runner: settings,
    runBacklogItem,
    submitTask,
    modelFor: () => "voice-model",
    mcpUrl: () => "http://127.0.0.1:4711/mcp",
    publish: (event) => events.push(event),
  });
});

afterEach(() => {
  voice.shutdown();
  opened.close();
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function idle(): Promise<VoiceState> {
  for (let i = 0; i < 100 && voice.state().busy; i++) await tick();
  return voice.state();
}

/** The bearer token the turn's CLI run got. */
function tokenOf(call = 0): string {
  const header = adapter.calls[call]?.options.permissions.harnessMcp?.headers.Authorization;
  return header?.replace(/^Bearer /, "") ?? "";
}

/** Starts a turn that runs until aborted, and returns its MCP access. */
async function liveTurn(
  text = "do it",
  repo = repoId,
  context: { clientId?: string; taskId?: string } = {},
): Promise<VoiceTurnAccess> {
  script = () => ({ hang: true });
  voice.command(repo, text, context);
  await tick();
  const access = voice.authorize(tokenOf(adapter.calls.length - 1));
  if (!access) throw new Error("no live turn");
  return access;
}

const lastVoice = () =>
  events.findLast((e): e is Extract<ServerEvent, { type: "voice.upserted" }> => {
    return e.type === "voice.upserted";
  })?.payload.voice;

describe("voice turns", () => {
  it("runs the repo's CLI once, read-only and Locked, with the blackwall MCP server", async () => {
    voice.command(repoId, "Create a task");
    expect(voice.state()).toMatchObject({ busy: true, repoId, transcript: "Create a task" });
    const state = await idle();
    expect(state).toMatchObject({ busy: false, reply: "Done.", error: null });
    expect(adapter.calls).toHaveLength(1);
    const { options } = adapter.calls[0]!;
    expect(options.cwd).toBe("/code/app");
    expect(options.model).toBe("voice-model");
    expect(options.maxTurns).toBe(8);
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.jsonSchema).toBeUndefined();
    expect(options.permissions).toMatchObject({ profile: "read-only", trust: { level: "locked" } });
    expect(options.permissions.harnessMcp).toEqual({
      name: "blackwall",
      url: "http://127.0.0.1:4711/mcp",
      headers: { Authorization: `Bearer ${tokenOf()}` },
      tools: VOICE_TOOL_NAMES,
    });
    expect(tokenOf()).toMatch(/^[\w-]{43}$/);
    expect(lastVoice()).toEqual(state);
  });

  it("puts the transcript, waiting items, runner and draft in the prompt", async () => {
    const waiting = r.backlogItems.insert({
      repoId,
      title: "Dark mode toggle",
      origin: { kind: "free-text" },
      freeText: "x",
    });
    r.backlogItems.insert({
      repoId: otherRepoId,
      title: "Foreign item",
      origin: { kind: "free-text" },
      freeText: "x",
    });
    voice.command(repoId, "start the dark mode task");
    await idle();
    const prompt = adapter.calls[0]!.options.prompt;
    expect(prompt).toContain(`\`${waiting.id}\` Dark mode toggle`);
    expect(prompt).not.toContain("Foreign item");
    expect(prompt).toContain("Backlog runner: on\n");
    expect(prompt).toContain("### Task draft\n\n(none)");
    expect(prompt.endsWith("start the dark mode task")).toBe(true);

    settings.setRepoBacklogRunnerEnabled(repoId, false);
    settings.updateGeneral({ backlogRunner: false });
    const access = await liveTurn("create a task");
    await voice.callTool(access, "create_task", { title: "Docs", description: "Write them" });
    voice.shutdown();
    voice.command(repoId, "confirm");
    await tick();
    const next = adapter.calls.at(-1)!.options.prompt;
    expect(next).toContain("Backlog runner: off (off for every repo in Settings)");
    expect(next).toContain("- title: Docs\n- description: Write them");
  });

  it("refuses a command while busy, and an unknown repo", async () => {
    expect(() => voice.command("nope", "hi")).toThrow(RepoNotFoundError);
    await liveTurn();
    expect(() => voice.command(repoId, "again")).toThrow(VoiceBusyError);
  });

  it("revokes the turn's token when it ends", async () => {
    voice.command(repoId, "hi");
    // The fake run settles on a later tick; the token is live until then.
    const token = tokenOf();
    expect(voice.authorize(token)).toEqual({ token, repoId, focusTaskId: null });
    expect(voice.authorize("wrong")).toBeNull();
    expect(voice.authorize(undefined)).toBeNull();
    await idle();
    expect(voice.authorize(token)).toBeNull();
  });

  it("aborts the running turn on shutdown and drops its result", async () => {
    const access = await liveTurn();
    voice.shutdown();
    await tick();
    expect(voice.authorize(access.token)).toBeNull();
    await expect(voice.callTool(access, "create_task", { title: "x" })).rejects.toThrow(
      "The voice command has ended",
    );
  });

  it("reports a failed run and a usage limit", async () => {
    script = () => ({ fail: "CLI crashed" });
    voice.command(repoId, "hi");
    expect(await idle()).toMatchObject({ busy: false, error: "CLI crashed", reply: null });
    script = () => ({ rateLimit: { resetsAt: "2026-10-20T18:00:00Z" } });
    voice.command(repoId, "hi");
    expect((await idle()).error).toBe(
      "The claude CLI hit its usage limit until 2026-10-20T18:00:00Z. Try again later.",
    );
  });
});

describe("draft tools", () => {
  it("creates a draft for the turn's repo, replacing any other", async () => {
    const access = await liveTurn();
    expect(await voice.callTool(access, "create_task", { title: " Dark mode " })).toBe(
      "Opened the New task form with 'Dark mode'.",
    );
    const first = voice.state().draft!;
    expect(first).toMatchObject({ repoId, title: "Dark mode", description: "", submitting: false });
    await voice.callTool(access, "create_task", { title: "Other", description: "D" });
    expect(voice.state().draft!.id).not.toBe(first.id);
    expect(lastVoice()?.draft).toMatchObject({ title: "Other", description: "D" });
  });

  it("updates the draft, bumping its revision, and appends to the description", async () => {
    const access = await liveTurn();
    await expect(voice.callTool(access, "update_task_draft", { title: "x" })).rejects.toThrow(
      VoiceToolError,
    );
    await voice.callTool(access, "create_task", { title: "Dark mode" });
    const { id, revision } = voice.state().draft!;
    await voice.callTool(access, "update_task_draft", { description: "Add a toggle" });
    await voice.callTool(access, "update_task_draft", { append_description: "Remember it" });
    expect(voice.state().draft).toMatchObject({
      id,
      title: "Dark mode",
      description: "Add a toggle\n\nRemember it",
      revision: revision + 2,
    });
    await voice.callTool(access, "update_task_draft", { title: "Theme switch" });
    expect(voice.state().draft).toMatchObject({ title: "Theme switch", revision: revision + 3 });
  });

  it("refuses invalid input and unknown tools as tool errors", async () => {
    const access = await liveTurn();
    await expect(voice.callTool(access, "create_task", { title: "  " })).rejects.toThrow(
      VoiceToolError,
    );
    await expect(voice.callTool(access, "delete_repo", {})).rejects.toThrow("Unknown tool");
  });
});

describe("submit_task_draft", () => {
  it("refuses with no draft or an empty description", async () => {
    const access = await liveTurn();
    await expect(voice.callTool(access, "submit_task_draft", {})).rejects.toThrow(
      "There is no task draft open",
    );
    await voice.callTool(access, "create_task", { title: "Dark mode" });
    await expect(voice.callTool(access, "submit_task_draft", {})).rejects.toThrow(
      "ask the user to describe the task",
    );
    expect(submitTask).not.toHaveBeenCalled();
  });

  it("creates the task once and reports it", async () => {
    submitTask.mockImplementation(async (id, input) => {
      const item = r.backlogItems.insert({
        repoId: id,
        title: input.title ?? "",
        origin: { kind: "free-text" },
        freeText: input.freeText ?? "",
      });
      return { ...item, taskId: "task-1", status: "promoted" };
    });
    const access = await liveTurn();
    await voice.callTool(access, "create_task", { title: "Dark mode", description: "A toggle" });
    expect(await voice.callTool(access, "submit_task_draft", {})).toBe(
      "Created and started task 'Dark mode'.",
    );
    expect(submitTask).toHaveBeenCalledTimes(1);
    expect(submitTask).toHaveBeenCalledWith(repoId, {
      origin: { kind: "free-text" },
      title: "Dark mode",
      freeText: "A toggle",
      start: true,
    });
    const state = voice.state();
    expect(state.draft).toBeNull();
    expect(state.created).toMatchObject({ repoId, taskId: "task-1", title: "Dark mode" });
    expect(lastVoice()).toEqual(state);
    // A turn's later command clears what the last one created.
    voice.shutdown();
    voice.command(repoId, "hi");
    expect(voice.state().created).toBeNull();
  });

  it("says when the task only went to the backlog", async () => {
    const access = await liveTurn();
    await voice.callTool(access, "create_task", { title: "Dark mode", description: "A toggle" });
    expect(await voice.callTool(access, "submit_task_draft", {})).toBe(
      "Added 'Dark mode' to the backlog; it starts when the backlog runner picks it.",
    );
    expect(voice.state().created).toMatchObject({ taskId: null });
  });

  it("keeps the draft open when the submit fails", async () => {
    submitTask.mockRejectedValueOnce(new Error("Title too long"));
    const access = await liveTurn();
    await voice.callTool(access, "create_task", { title: "Dark mode", description: "A toggle" });
    await expect(voice.callTool(access, "submit_task_draft", {})).rejects.toThrow(
      new VoiceToolError("Title too long"),
    );
    expect(voice.state().draft).toMatchObject({ title: "Dark mode", submitting: false });
  });
});

describe("submitDraft", () => {
  async function openDraft() {
    const access = await liveTurn();
    await voice.callTool(access, "create_task", { title: "Dark mode", description: "A toggle" });
    return { access, id: voice.state().draft!.id };
  }

  it("creates the task exactly once across concurrent submits", async () => {
    const { id } = await openDraft();
    const results = await Promise.allSettled([voice.submitDraft(id), voice.submitDraft(id)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(VoiceDraftConflictError);
    expect(submitTask).toHaveBeenCalledTimes(1);
    await expect(voice.submitDraft(id)).rejects.toThrow(VoiceDraftConflictError);
    await expect(voice.submitDraft("stale")).rejects.toThrow(VoiceDraftConflictError);
  });

  it("refuses new drafts while one is being created", async () => {
    let finish: (item: BacklogItem) => void = () => undefined;
    submitTask.mockImplementationOnce(
      () =>
        new Promise<BacklogItem>((resolve) => {
          finish = resolve;
        }),
    );
    const { access, id } = await openDraft();
    const pending = voice.submitDraft(id);
    expect(voice.state().draft?.submitting).toBe(true);
    await expect(voice.callTool(access, "create_task", { title: "Other" })).rejects.toThrow(
      "still being created",
    );
    await expect(voice.callTool(access, "update_task_draft", { title: "Other" })).rejects.toThrow(
      "already being created",
    );
    voice.clearDraft(id);
    expect(voice.state().draft?.id).toBe(id);
    finish(
      r.backlogItems.insert({
        repoId,
        title: "Dark mode",
        origin: { kind: "free-text" },
        freeText: "A toggle",
      }),
    );
    await pending;
    expect(voice.state().draft).toBeNull();
  });

  it("forwards the form's input with start set", async () => {
    const { id } = await openDraft();
    const input: NewBacklogItemInput = {
      origin: { kind: "free-text" },
      title: "Edited",
      freeText: "Typed by hand",
      agents: { planner: "a1" },
      start: false,
    };
    await voice.submitDraft(id, input);
    expect(submitTask).toHaveBeenCalledWith(repoId, { ...input, start: true });
  });
});

describe("clearDraft", () => {
  it("closes the draft and ignores a stale id", async () => {
    const access = await liveTurn();
    await voice.callTool(access, "create_task", { title: "Dark mode" });
    const { id } = voice.state().draft!;
    voice.clearDraft("stale");
    expect(voice.state().draft?.id).toBe(id);
    voice.clearDraft(id);
    expect(voice.state().draft).toBeNull();
  });
});

describe("backlog tools", () => {
  it("starts only a waiting item of the turn's repo", async () => {
    const mine = r.backlogItems.insert({
      repoId,
      title: "Dark mode",
      origin: { kind: "free-text" },
      freeText: "x",
    });
    const paused = r.backlogItems.insert({
      repoId,
      title: "Paused",
      origin: { kind: "free-text" },
      freeText: "x",
    });
    r.backlogItems.update(paused.id, { status: "paused" });
    const foreign = r.backlogItems.insert({
      repoId: otherRepoId,
      title: "Foreign",
      origin: { kind: "free-text" },
      freeText: "x",
    });
    const access = await liveTurn();
    await expect(
      voice.callTool(access, "run_backlog_item", { item_id: foreign.id }),
    ).rejects.toThrow(VoiceToolError);
    await expect(
      voice.callTool(access, "run_backlog_item", { item_id: paused.id }),
    ).rejects.toThrow("is not waiting");
    expect(runBacklogItem).not.toHaveBeenCalled();
    expect(await voice.callTool(access, "run_backlog_item", { item_id: mine.id })).toBe(
      "Started 'Dark mode'.",
    );
    expect(runBacklogItem).toHaveBeenCalledWith(repoId, mine.id);
  });

  it("switches the repo's runner, announces it and warns when Settings has it off", async () => {
    const access = await liveTurn();
    expect(await voice.callTool(access, "set_backlog_runner", { enabled: false })).toBe(
      "Turned the backlog runner off for this repo.",
    );
    expect(settings.repoBacklogRunner(repoId).enabled).toBe(false);
    expect(events).toContainEqual({ type: "backlog.changed", payload: { repoId } });
    expect(await voice.callTool(access, "set_backlog_runner", { enabled: true })).toBe(
      "Turned the backlog runner on for this repo.",
    );
    settings.updateGeneral({ backlogRunner: false });
    expect(await voice.callTool(access, "set_backlog_runner", { enabled: true })).toContain(
      "The runner is off for every repo in Settings",
    );
    expect(settings.repoBacklogRunner(repoId)).toMatchObject({ enabled: true, autonomous: false });
  });
});

function seedTask(patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {}): Task {
  return r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId,
    ...patch,
  });
}

describe("UI action tools", () => {
  it("queues the grid wall and a repo switch, each with an id", async () => {
    const access = await liveTurn("show the grid, then switch to other");
    expect(await voice.callTool(access, "show_grid_wall", {})).toBe("Showing the grid wall.");
    expect(await voice.callTool(access, "select_repo", { repo_id: otherRepoId })).toBe(
      "Switched to other.",
    );
    const actions = lastVoice()!.actions;
    expect(actions).toMatchObject([
      { kind: "show-grid" },
      { kind: "select-repo", repoId: otherRepoId },
    ]);
    expect(actions[0]!.id).not.toBe(actions[1]!.id);
  });

  it("refuses an unknown repo", async () => {
    const access = await liveTurn();
    await expect(voice.callTool(access, "select_repo", { repo_id: "nope" })).rejects.toThrow(
      new VoiceToolError("No repository nope"),
    );
    expect(voice.state().actions).toEqual([]);
  });
});

describe("send_chat_message", () => {
  it("writes to the focused task's conversation and opens the chat", async () => {
    const task = seedTask();
    const access = await liveTurn("write to chat", repoId, { taskId: task.id });
    expect(await voice.callTool(access, "send_chat_message", { text: "Summarise" })).toBe(
      "Sent the message to the chat of 'Fix login'.",
    );
    expect(sendChat).toHaveBeenCalledWith(repoId, "Summarise", task.id);
    expect(voice.state().actions).toMatchObject([{ kind: "open-chat" }]);
  });

  it("uses the focused task's own repo", async () => {
    const task = seedTask({ repoId: otherRepoId });
    const access = await liveTurn("write to chat", repoId, { taskId: task.id });
    await voice.callTool(access, "send_chat_message", { text: "Summarise" });
    expect(sendChat).toHaveBeenCalledWith(otherRepoId, "Summarise", task.id);
  });

  it("writes to the selected repo's chat with no focused task", async () => {
    const access = await liveTurn();
    expect(await voice.callTool(access, "send_chat_message", { text: "What fails?" })).toBe(
      "Sent the message to the repo chat.",
    );
    expect(sendChat).toHaveBeenCalledWith(repoId, "What fails?");
    expect(sendChat.mock.calls[0]![2]).toBeUndefined();
  });

  it("relays a busy chat and opens nothing", async () => {
    sendChat.mockImplementation(() => {
      throw new Error("The chat is still answering");
    });
    const access = await liveTurn();
    await expect(voice.callTool(access, "send_chat_message", { text: "hi" })).rejects.toThrow(
      new VoiceToolError("The chat is still answering"),
    );
    expect(voice.state().actions).toEqual([]);
  });
});

describe("answer_grill_question", () => {
  /** A planner-answered Q1, then Q2 and Q3 open for the user. */
  function seedQuestions(task: Task) {
    r.tasks.update(task.id, { status: "needs-you", gate: "questions" });
    const planner = r.grillQuestions.create({ taskId: task.id, question: "Which file?" });
    r.grillQuestions.answer(planner.id, "app.ts", "planner");
    const first = r.grillQuestions.create({ taskId: task.id, question: "Dark?", needsHuman: true });
    const second = r.grillQuestions.create({
      taskId: task.id,
      question: "Keep?",
      needsHuman: true,
    });
    return { first, second };
  }

  it("answers the question by its number, in the task's own repo", async () => {
    const task = seedTask({ repoId: otherRepoId });
    const { second } = seedQuestions(task);
    const access = await liveTurn("answer question 3: yes", repoId, { taskId: task.id });
    expect(adapter.calls[0]!.options.prompt).toContain("- Q2: Dark?\n- Q3: Keep?");
    expect(
      await voice.callTool(access, "answer_grill_question", { number: 3, answer: "yes" }),
    ).toBe("Answered question 3.");
    expect(answerQuestion).toHaveBeenCalledWith(task.id, second.id, "yes");
  });

  it("says when the last answer moved the task on", async () => {
    const task = seedTask();
    const { first } = seedQuestions(task);
    answerQuestion.mockImplementationOnce(async (taskId, questionId, answer) => ({
      question: r.grillQuestions.answer(questionId, answer, "user"),
      task: r.tasks.update(taskId, { status: "queued", gate: null }),
    }));
    const access = await liveTurn("answer", repoId, { taskId: task.id });
    expect(await voice.callTool(access, "answer_grill_question", { number: 2, answer: "no" })).toBe(
      "Answered question 2, the last open one; the task moves on.",
    );
    expect(answerQuestion).toHaveBeenCalledWith(task.id, first.id, "no");
  });

  it("refuses a missing number, a question not open for the user and no focused task", async () => {
    const task = seedTask();
    seedQuestions(task);
    const access = await liveTurn("answer", repoId, { taskId: task.id });
    await expect(
      voice.callTool(access, "answer_grill_question", { number: 4, answer: "yes" }),
    ).rejects.toThrow(new VoiceToolError("No question 4"));
    await expect(
      voice.callTool(access, "answer_grill_question", { number: 1, answer: "yes" }),
    ).rejects.toThrow(new VoiceToolError("Question 1 is not waiting on you"));
    voice.shutdown();
    const unfocused = await liveTurn("answer");
    await expect(
      voice.callTool(unfocused, "answer_grill_question", { number: 2, answer: "yes" }),
    ).rejects.toThrow(new VoiceToolError("Open the task first"));
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});

describe("approve_plan", () => {
  it("approves the focused task's plan at its gate", async () => {
    const task = seedTask();
    r.tasks.update(task.id, { status: "needs-you", gate: "plan-approval" });
    const access = await liveTurn("approve the plan", repoId, { taskId: task.id });
    expect(await voice.callTool(access, "approve_plan", {})).toBe(
      "Approved the plan of 'Fix login'.",
    );
    expect(approvePlan).toHaveBeenCalledWith(task.id);
  });

  it("refuses another gate and no focused task", async () => {
    const task = seedTask();
    r.tasks.update(task.id, { status: "needs-you", gate: "questions" });
    const access = await liveTurn("approve the plan", repoId, { taskId: task.id });
    await expect(voice.callTool(access, "approve_plan", {})).rejects.toThrow(
      new VoiceToolError("'Fix login' is not waiting on plan approval"),
    );
    voice.shutdown();
    const unfocused = await liveTurn("approve the plan");
    await expect(voice.callTool(unfocused, "approve_plan", {})).rejects.toThrow(
      new VoiceToolError("Open the task first"),
    );
    expect(approvePlan).not.toHaveBeenCalled();
  });
});

describe("open_task", () => {
  it("opens only a task waiting on the user", async () => {
    const waiting = seedTask({ repoId: otherRepoId, title: "Waiting" });
    r.tasks.update(waiting.id, { status: "needs-you", gate: "plan-approval" });
    const running = seedTask({ title: "Running" });
    r.tasks.update(running.id, { status: "running" });
    const access = await liveTurn("open the task that needs me");
    expect(adapter.calls[0]!.options.prompt).toContain(
      `### Tasks waiting on you\n\n- \`${waiting.id}\` Waiting (other, plan-approval)\n`,
    );
    expect(await voice.callTool(access, "open_task", { task_id: waiting.id })).toBe(
      "Opened 'Waiting'.",
    );
    expect(voice.state().actions).toMatchObject([{ kind: "open-task", taskId: waiting.id }]);
    await expect(voice.callTool(access, "open_task", { task_id: running.id })).rejects.toThrow(
      new VoiceToolError(`Task ${running.id} is not waiting on you`),
    );
  });
});

describe("command context", () => {
  it("stores the client and clears the last command's actions", async () => {
    const access = await liveTurn("go home", repoId, { clientId: "c1" });
    await voice.callTool(access, "show_grid_wall", {});
    expect(voice.state()).toMatchObject({ clientId: "c1", actions: [{ kind: "show-grid" }] });
    voice.shutdown();
    voice.command(repoId, "hi", { clientId: "c2" });
    expect(lastVoice()).toMatchObject({ clientId: "c2", actions: [] });
    voice.shutdown();
    voice.command(repoId, "hi");
    expect(lastVoice()).toMatchObject({ clientId: null, actions: [] });
  });

  it("ignores an unknown or archived task, and keeps one of another repo", async () => {
    const archived = seedTask();
    r.tasks.update(archived.id, { status: "done", archivedAt: new Date() });
    expect((await liveTurn("hi", repoId, { taskId: "nope" })).focusTaskId).toBeNull();
    voice.shutdown();
    expect((await liveTurn("hi", repoId, { taskId: archived.id })).focusTaskId).toBeNull();
    expect(adapter.calls[1]!.options.prompt).toContain("### Focused task\n\n(none)");
    voice.shutdown();
    const foreign = seedTask({ repoId: otherRepoId, title: "Foreign" });
    expect((await liveTurn("hi", repoId, { taskId: foreign.id })).focusTaskId).toBe(foreign.id);
    expect(adapter.calls[2]!.options.prompt).toContain("- repo: other");
  });
});
