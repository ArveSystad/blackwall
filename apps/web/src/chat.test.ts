import { MAX_TITLE_CHARS, type ChatAction, type ChatMessage } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DEFAULT_WIDTH,
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  actionAvailability,
  canSendChat,
  canTurnIntoTask,
  chatActionSummary,
  chatPanelMotion,
  chatWidthBounds,
  clampChatWidth,
  clearNeedsConfirm,
  freshMessageIds,
  isClearCommand,
  needsCardId,
  nextChatPresence,
  nextChatWidth,
  settleChatPresence,
  turnIntoTaskProposal,
  type ChatPresence,
} from "./chat";
import { makeTask } from "./test-fixtures";

/** Minimal in-memory Storage stand-in; the web tests run without a DOM. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

async function loadChat() {
  // Fresh module per test so the in-memory layout starts unset.
  vi.resetModules();
  return import("./chat");
}

function action(fields: Record<string, unknown>, appliedAt: string | null = null): ChatAction {
  return { id: `a-${JSON.stringify(fields)}`, appliedAt, ...fields } as ChatAction;
}

function assistant(id: string, actions: ChatAction[]): ChatMessage {
  return { id, role: "assistant", text: "Ok", actions, createdAt: "2026-10-14T10:00:00.000Z" };
}

describe("chat width", () => {
  it("caps at the maximum in a wide window and keeps a fitting preference", () => {
    expect(chatWidthBounds(2400)).toEqual({ min: CHAT_MIN_WIDTH, max: CHAT_MAX_WIDTH });
    expect(clampChatWidth(1200, 2400)).toBe(CHAT_MAX_WIDTH);
    expect(clampChatWidth(CHAT_DEFAULT_WIDTH, 1600)).toBe(CHAT_DEFAULT_WIDTH);
  });

  it("leaves the sidebar and the main pane their room", () => {
    expect(chatWidthBounds(1100).max).toBe(388);
    expect(clampChatWidth(500, 1100)).toBe(388);
  });

  it("stays at the minimum in a narrow window", () => {
    expect(chatWidthBounds(900)).toEqual({ min: CHAT_MIN_WIDTH, max: CHAT_MIN_WIDTH });
    expect(clampChatWidth(CHAT_DEFAULT_WIDTH, 700)).toBe(CHAT_MIN_WIDTH);
    expect(clampChatWidth(100, 2400)).toBe(CHAT_MIN_WIDTH);
  });

  it("steps with the arrow keys and jumps with Home and End, clamped", () => {
    expect(nextChatWidth("ArrowLeft", 400, 2400)).toBe(416);
    expect(nextChatWidth("ArrowRight", 400, 2400)).toBe(384);
    expect(nextChatWidth("Home", 400, 2400)).toBe(CHAT_MIN_WIDTH);
    expect(nextChatWidth("End", 400, 2400)).toBe(CHAT_MAX_WIDTH);
    expect(nextChatWidth("End", 300, 1100)).toBe(388);
    expect(nextChatWidth("ArrowLeft", 388, 1100)).toBe(388);
    expect(nextChatWidth("ArrowRight", CHAT_MIN_WIDTH, 2400)).toBe(CHAT_MIN_WIDTH);
    expect(nextChatWidth("a", 400, 2400)).toBeNull();
  });
});

describe("chat panel presence", () => {
  const all: ChatPresence[] = ["closed", "opening", "open", "closing"];

  it("opens with a slide, or at once under reduced motion", () => {
    expect(nextChatPresence("closed", true, false)).toBe("opening");
    expect(nextChatPresence("closed", true, true)).toBe("open");
    expect(nextChatPresence("open", true, false)).toBe("open");
    expect(nextChatPresence("opening", true, false)).toBe("opening");
  });

  it("stays mounted while closing and unmounts once settled", () => {
    expect(nextChatPresence("open", false, false)).toBe("closing");
    expect(nextChatPresence("opening", false, false)).toBe("closing");
    expect(settleChatPresence("closing")).toBe("closed");
    expect(nextChatPresence("open", false, true)).toBe("closed");
    expect(nextChatPresence("closed", false, false)).toBe("closed");
  });

  it("reopens mid-close and settles open", () => {
    expect(nextChatPresence("closing", true, false)).toBe("opening");
    expect(settleChatPresence("opening")).toBe("open");
    expect(settleChatPresence("open")).toBe("open");
    expect(settleChatPresence("closed")).toBe("closed");
  });

  it("transitions only while sliding, never while dragging or resting", () => {
    expect(chatPanelMotion("opening", false)).toBe("opening");
    expect(chatPanelMotion("closing", false)).toBe("closing");
    expect(chatPanelMotion("open", false)).toBeNull();
    expect(chatPanelMotion("closed", false)).toBeNull();
    for (const presence of all) expect(chatPanelMotion(presence, true)).toBeNull();
  });
});

describe("chat layout", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts closed at the default width", async () => {
    const { readChatLayout } = await loadChat();
    expect(readChatLayout()).toEqual({ open: false, width: CHAT_DEFAULT_WIDTH });
  });

  it("remembers the open state and the preferred width", async () => {
    const { toggleChat, setChatWidth, readChatLayout, takeChatFocusRequest, CHAT_STORAGE_KEY } =
      await loadChat();
    expect(toggleChat()).toBe(true);
    expect(takeChatFocusRequest()).toBe(true);
    expect(takeChatFocusRequest()).toBe(false);
    setChatWidth(512);
    expect(readChatLayout()).toEqual({ open: true, width: 512 });
    expect(JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)!)).toEqual({ open: true, width: 512 });
    expect(toggleChat()).toBe(false);
    expect(readChatLayout().open).toBe(false);
  });

  it("limits a stored width and ignores invalid storage", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "blackwall.chat": JSON.stringify({ open: true, width: 5000 }) }),
    );
    let chat = await loadChat();
    expect(chat.chatLayout()).toEqual({ open: true, width: CHAT_MAX_WIDTH });

    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.chat": "not json" }));
    chat = await loadChat();
    expect(chat.readChatLayout()).toEqual({ open: false, width: CHAT_DEFAULT_WIDTH });
  });

  it("falls back to the default when storage throws, and still toggles for the page", async () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { readChatLayout, toggleChat, chatLayout } = await loadChat();
    expect(readChatLayout()).toEqual({ open: false, width: CHAT_DEFAULT_WIDTH });
    expect(toggleChat()).toBe(true);
    expect(chatLayout().open).toBe(true);
  });
});

describe("actionAvailability", () => {
  const running = makeTask({ repoId: "r1", status: "running", stage: "implement" });
  const atPlan = makeTask({ repoId: "r1", status: "needs-you", gate: "plan-approval" });
  const atQuestions = makeTask({ repoId: "r1", status: "needs-you", gate: "questions" });
  const failed = makeTask({ repoId: "r1", status: "failed" });
  const foreign = makeTask({ repoId: "r2", status: "running" });
  const tasks = [running, atPlan, atQuestions, failed, foreign];
  const check = (a: ChatAction) => actionAvailability(a, tasks, "r1");

  it("reports applied actions", () => {
    expect(
      check(action({ kind: "stop-task", taskId: running.id }, "2026-10-14T10:00:00Z")),
    ).toEqual({ kind: "applied" });
  });

  it("always allows a new backlog task", () => {
    expect(check(action({ kind: "create-task", title: "x", description: "y" }))).toEqual({
      kind: "available",
    });
  });

  it("refuses tasks that are gone or in another repo", () => {
    const gone = { kind: "unavailable", reason: "This task no longer exists" };
    expect(check(action({ kind: "stop-task", taskId: "missing" }))).toEqual(gone);
    expect(check(action({ kind: "stop-task", taskId: foreign.id }))).toEqual(gone);
  });

  it("sends messages only to a task at a gate that takes one", () => {
    expect(check(action({ kind: "message-task", taskId: atPlan.id, message: "m" }))).toEqual({
      kind: "available",
    });
    expect(check(action({ kind: "message-task", taskId: running.id, message: "m" }))).toMatchObject(
      { kind: "unavailable", reason: expect.stringContaining("at a gate") },
    );
    expect(
      check(action({ kind: "message-task", taskId: atQuestions.id, message: "m" })),
    ).toMatchObject({ kind: "unavailable", reason: "This task's gate takes no message" });
  });

  it("stops queued, running or waiting tasks and resumes interrupted or failed ones", () => {
    expect(check(action({ kind: "stop-task", taskId: running.id })).kind).toBe("available");
    expect(check(action({ kind: "stop-task", taskId: atQuestions.id })).kind).toBe("available");
    expect(check(action({ kind: "stop-task", taskId: failed.id })).kind).toBe("unavailable");
    expect(check(action({ kind: "resume-task", taskId: failed.id })).kind).toBe("available");
    expect(check(action({ kind: "resume-task", taskId: running.id })).kind).toBe("unavailable");
  });
});

describe("chatActionSummary", () => {
  it("describes a new backlog task by its proposed title and description", () => {
    expect(
      chatActionSummary(
        action({ kind: "create-task", title: "Add tests", description: "D" }),
        undefined,
      ),
    ).toEqual({ label: "New backlog task", title: "Add tests", detail: "D" });
  });

  it("names the gate answer and the task's title for a message", () => {
    const atPlan = makeTask({ title: "Dark mode", status: "needs-you", gate: "plan-approval" });
    const atTriage = makeTask({ title: "Fix login", status: "needs-you", gate: "triage" });
    expect(
      chatActionSummary(action({ kind: "message-task", taskId: atPlan.id, message: "M" }), atPlan),
    ).toEqual({ label: "Request changes · planner", title: "Dark mode", detail: "M" });
    expect(
      chatActionSummary(
        action({ kind: "message-task", taskId: atTriage.id, message: "M" }),
        atTriage,
      ).label,
    ).toBe("Start fix round · implementer");
  });

  it("uses the task's title for stop and resume, and the raw id when it is gone", () => {
    const task = makeTask({ title: "Refactor" });
    expect(chatActionSummary(action({ kind: "stop-task", taskId: task.id }), task)).toEqual({
      label: "Stop task",
      title: "Refactor",
    });
    expect(chatActionSummary(action({ kind: "resume-task", taskId: task.id }), task).label).toBe(
      "Resume task",
    );
    expect(
      chatActionSummary(action({ kind: "stop-task", taskId: "t-gone" }), undefined).title,
    ).toBe("t-gone");
  });
});

describe("sending and clearing", () => {
  it("sends any text while idle and only /clear while answering", () => {
    expect(canSendChat("Hi", false)).toBe(true);
    expect(canSendChat("  ", false)).toBe(false);
    expect(canSendChat("Hi", true)).toBe(false);
    expect(canSendChat(" /clear ", true)).toBe(true);
    expect(isClearCommand("/clear")).toBe(true);
    expect(isClearCommand("/clear all")).toBe(false);
  });

  it("asks before clearing only while answering", () => {
    expect(clearNeedsConfirm(true)).toBe(true);
    expect(clearNeedsConfirm(false)).toBe(false);
  });
});

describe("needsCardId", () => {
  const atPlan = makeTask({ repoId: "r1", status: "needs-you", gate: "plan-approval" });
  const atTriage = makeTask({ repoId: "r1", status: "needs-you", gate: "triage" });
  const tasks = [atPlan, atTriage];

  it("picks the first available message card of the newest assistant message", () => {
    const first = action({ kind: "message-task", taskId: atPlan.id, message: "1" });
    const second = action({ kind: "message-task", taskId: atTriage.id, message: "2" });
    const older = action({ kind: "message-task", taskId: atPlan.id, message: "old" });
    const messages = [assistant("m1", [older]), assistant("m2", [first, second])];
    expect(needsCardId(messages, tasks, "r1")).toBe(first.id);
  });

  it("skips applied and unavailable cards", () => {
    const applied = action(
      { kind: "message-task", taskId: atPlan.id, message: "1" },
      "2026-10-14T10:00:00Z",
    );
    const gone = action({ kind: "message-task", taskId: "gone", message: "2" });
    const open = action({ kind: "message-task", taskId: atTriage.id, message: "3" });
    expect(needsCardId([assistant("m1", [applied, gone, open])], tasks, "r1")).toBe(open.id);
    expect(needsCardId([assistant("m1", [applied, gone])], tasks, "r1")).toBeNull();
    expect(needsCardId([], tasks, "r1")).toBeNull();
  });
});

describe("freshMessageIds", () => {
  it("returns only the ids not seen yet", () => {
    const messages = [assistant("m1", []), assistant("m2", []), assistant("m3", [])];
    expect(freshMessageIds(messages, new Set(["m1", "m3"]))).toEqual(["m2"]);
    expect(freshMessageIds(messages, new Set(["m1", "m2", "m3"]))).toEqual([]);
  });
});

describe("turnIntoTaskProposal", () => {
  const reply = (text: string, actions: ChatAction[] = []) => ({
    ...assistant("m", actions),
    text,
  });

  it("titles the task with the first line, without a heading marker", () => {
    expect(turnIntoTaskProposal(reply("  ## Fix the bug\n\nDetails\n"))).toEqual({
      kind: "create-task",
      title: "Fix the bug",
      description: "## Fix the bug\n\nDetails",
    });
  });

  it("skips leading blank lines", () => {
    expect(turnIntoTaskProposal(reply("\n  \n\nFirst\nSecond"))?.title).toBe("First");
  });

  it("caps a long first line", () => {
    const title = turnIntoTaskProposal(reply("x".repeat(MAX_TITLE_CHARS + 10)))!.title;
    expect(title).toHaveLength(MAX_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back for a bare heading marker and returns null for blank text", () => {
    expect(turnIntoTaskProposal(reply("## \nBody"))?.title).toBe("Untitled task");
    expect(turnIntoTaskProposal(reply("  \n "))).toBeNull();
  });

  it("is offered until a card for the same text exists", () => {
    expect(canTurnIntoTask(reply("Do it"))).toBe(true);
    const same = action({ kind: "create-task", title: "Do it", description: "Do it" });
    expect(canTurnIntoTask(reply("Do it", [same]))).toBe(false);
    const other = action({ kind: "create-task", title: "Other", description: "Other" });
    expect(canTurnIntoTask(reply("Do it", [other]))).toBe(true);
  });
});
