import {
  CHAT_CLEAR_COMMAND,
  MAX_TITLE_CHARS,
  type ChatAction,
  type ChatActionProposal,
  type ChatMessage,
  type Task,
} from "@blackwall/shared";
import { useSyncExternalStore } from "react";
import { messageRoute } from "./components/task/actions";
import { isModKey, isPlainKey, isTypingTarget, useWindowKeydown } from "./keyboard";
import { canStop } from "./task-view";

/**
 * The repo chat panel on the right, the selected repo's chat on every page, and the task channel
 * on each task page. Whether each is open, and the panel's preferred width, are remembered per
 * browser, like the theme; the conversations themselves live on the server.
 */
export const CHAT_STORAGE_KEY = "blackwall.chat";

export const CHAT_MIN_WIDTH = 250;
export const CHAT_MAX_WIDTH = 900;
export const CHAT_DEFAULT_WIDTH = 380;
/** The fixed left column: the inbox, Settings and Stats navs and the top bar's wordmark (`w-[352px]`). */
export const CHAT_SIDEBAR_WIDTH = 352;
/** The main pane keeps at least this much beside the chat, when the window allows. */
export const CHAT_MAIN_MIN_WIDTH = 360;
/** One arrow key press on the resize handle. */
export const CHAT_WIDTH_STEP = 16;
/** The side panel's repo chat composer textarea. */
export const CHAT_INPUT_ID = "chat-input";
/** The task channel's composer textarea, on a task page. */
export const TASK_CHAT_INPUT_ID = "task-chat-input";

export interface ChatLayout {
  open: boolean;
  /** The user's preferred width; the rendered width is clamped to the window. */
  width: number;
}

const DEFAULT_LAYOUT: ChatLayout = { open: false, width: CHAT_DEFAULT_WIDTH };

const listeners = new Set<() => void>();
let current: ChatLayout | undefined;
/** Set when the user opens the panel, so it focuses its input; a reload with it open does not. */
let focusRequested = false;

function limitWidth(width: number): number {
  return Math.round(Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, width)));
}

/** The stored layout: closed at the default width unless storage holds a valid one. */
export function readChatLayout(): ChatLayout {
  try {
    const raw = globalThis.localStorage?.getItem(CHAT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_LAYOUT;
    const { open, width } = value as Record<string, unknown>;
    return {
      open: open === true,
      width:
        typeof width === "number" && Number.isFinite(width)
          ? limitWidth(width)
          : CHAT_DEFAULT_WIDTH,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** The chat layout in effect for this page. */
export function chatLayout(): ChatLayout {
  current ??= readChatLayout();
  return current;
}

function writeLayout(layout: ChatLayout): void {
  current = layout;
  try {
    globalThis.localStorage?.setItem(CHAT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage is a convenience; the layout still applies for this page.
  }
  for (const listener of listeners) listener();
}

/**
 * Opens or closes the panel. Opening asks the panel to focus its input; closing returns focus to
 * the top bar's chat toggle, since the focused element may be inside the panel.
 */
export function setChatOpen(open: boolean): void {
  const layout = chatLayout();
  if (layout.open === open) return;
  focusRequested = open;
  writeLayout({ ...layout, open });
  if (!open && typeof document !== "undefined") document.getElementById("chat-toggle")?.focus();
}

/** Opens a closed panel and closes an open one; returns whether it is now open. */
export function toggleChat(): boolean {
  const open = !chatLayout().open;
  setChatOpen(open);
  return open;
}

/** Puts the cursor in the side panel's repo chat composer, opening the panel first when it is closed. */
export function focusChat(): void {
  if (!chatLayout().open) {
    setChatOpen(true);
    return;
  }
  document.getElementById(CHAT_INPUT_ID)?.focus();
}

/** Stores the preferred width, from dragging or the keyboard; never from a window resize. */
export function setChatWidth(width: number): void {
  writeLayout({ ...chatLayout(), width: limitWidth(width) });
}

/** True once after the user opened the panel: it should focus its input. */
export function takeChatFocusRequest(): boolean {
  const requested = focusRequested;
  focusRequested = false;
  return requested;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The chat layout, re-rendering when it changes. */
export function useChatLayout(): ChatLayout {
  return useSyncExternalStore(subscribe, chatLayout, () => DEFAULT_LAYOUT);
}

/** The task channel on a task page: whether its history is open. Global per browser, not per task. */
export const TASK_CHAT_STORAGE_KEY = "blackwall.task-chat";

export interface TaskChatLayout {
  open: boolean;
}

const DEFAULT_TASK_CHAT_LAYOUT: TaskChatLayout = { open: false };

const taskChatListeners = new Set<() => void>();
let taskChatCurrent: TaskChatLayout | undefined;

/** The stored task channel layout: collapsed unless storage holds a valid one. */
export function readTaskChatLayout(): TaskChatLayout {
  try {
    const raw = globalThis.localStorage?.getItem(TASK_CHAT_STORAGE_KEY);
    if (!raw) return DEFAULT_TASK_CHAT_LAYOUT;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_TASK_CHAT_LAYOUT;
    return { open: (value as Record<string, unknown>).open === true };
  } catch {
    return DEFAULT_TASK_CHAT_LAYOUT;
  }
}

/** The task channel layout in effect for this page. */
export function taskChatLayout(): TaskChatLayout {
  taskChatCurrent ??= readTaskChatLayout();
  return taskChatCurrent;
}

function writeTaskChatLayout(layout: TaskChatLayout): void {
  taskChatCurrent = layout;
  try {
    globalThis.localStorage?.setItem(TASK_CHAT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage is a convenience; the layout still applies for this page.
  }
  for (const listener of taskChatListeners) listener();
}

/** Opens or folds the task channel's history. */
export function setTaskChatOpen(open: boolean): void {
  if (taskChatLayout().open === open) return;
  writeTaskChatLayout({ open });
}

/** Opens folded history and folds open history; returns whether it is now open. */
export function toggleTaskChat(): boolean {
  const open = !taskChatLayout().open;
  setTaskChatOpen(open);
  return open;
}

/**
 * Puts the cursor in the task channel's composer, opening its history. The composer is always
 * mounted on a task page, so it can focus at once.
 */
export function focusTaskChat(): void {
  setTaskChatOpen(true);
  document.getElementById(TASK_CHAT_INPUT_ID)?.focus();
}

function subscribeTaskChat(listener: () => void): () => void {
  taskChatListeners.add(listener);
  return () => taskChatListeners.delete(listener);
}

/** The task channel layout, re-rendering when it changes. */
export function useTaskChatLayout(): TaskChatLayout {
  return useSyncExternalStore(subscribeTaskChat, taskChatLayout, () => DEFAULT_TASK_CHAT_LAYOUT);
}

/** The panel's width range in a window `viewport` px wide; `max` never drops below `min`. */
export function chatWidthBounds(viewport: number): { min: number; max: number } {
  const room = viewport - CHAT_SIDEBAR_WIDTH - CHAT_MAIN_MIN_WIDTH;
  return { min: CHAT_MIN_WIDTH, max: Math.max(CHAT_MIN_WIDTH, Math.min(CHAT_MAX_WIDTH, room)) };
}

/** The width the panel renders at: the preferred width, within {@link chatWidthBounds}. */
export function clampChatWidth(width: number, viewport: number): number {
  const { min, max } = chatWidthBounds(viewport);
  return Math.round(Math.max(min, Math.min(width, max)));
}

/**
 * The width after a key press on the resize handle, or null for other keys. The handle is the
 * panel's left edge, so ArrowLeft widens and ArrowRight narrows; Home and End go to the bounds.
 */
export function nextChatWidth(key: string, width: number, viewport: number): number | null {
  const { min, max } = chatWidthBounds(viewport);
  switch (key) {
    case "ArrowLeft":
      return clampChatWidth(width + CHAT_WIDTH_STEP, viewport);
    case "ArrowRight":
      return clampChatWidth(width - CHAT_WIDTH_STEP, viewport);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/**
 * Where the panel is in its open/close slide. It stays mounted while `opening` and `closing`, so
 * reopening mid-close keeps the draft.
 */
export type ChatPresence = "closed" | "opening" | "open" | "closing";

/** The open/close slide: 180ms, paired with `.bw-chat` in styles.css. Change them together. */
export const CHAT_PANEL_MS = 180;
/** Settles the slide when no `transitionend` comes (reduced motion, background tab, old engine). */
export const CHAT_PANEL_FALLBACK_MS = CHAT_PANEL_MS + 50;

/** The presence after the layout's `open` changes; reduced motion skips the slide. */
export function nextChatPresence(
  presence: ChatPresence,
  open: boolean,
  reduced: boolean,
): ChatPresence {
  if (open) {
    if (presence === "closed" || presence === "closing") return reduced ? "open" : "opening";
    return presence;
  }
  if (presence === "open" || presence === "opening") return reduced ? "closed" : "closing";
  return presence;
}

/** The presence once the slide ends. Idempotent, so `transitionend` and the fallback can both call it. */
export function settleChatPresence(presence: ChatPresence): ChatPresence {
  if (presence === "opening") return "open";
  if (presence === "closing") return "closed";
  return presence;
}

/**
 * The panel's `data-motion`, which turns its width transition on. Null while resting or dragging,
 * so resizing and window clamping never animate.
 */
export function chatPanelMotion(
  presence: ChatPresence,
  dragging: boolean,
): "opening" | "closing" | null {
  if (dragging) return null;
  return presence === "opening" || presence === "closing" ? presence : null;
}

function subscribeResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

/** The window's width, re-rendering on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribeResize,
    () => window.innerWidth,
    () => 1280,
  );
}

/** The global `C` shortcut. Register once at app level so it works on every route. */
export function useChatHotkey(): void {
  useWindowKeydown((event) => {
    if (event.repeat || !isPlainKey(event) || isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() !== "c") return;
    event.preventDefault();
    toggleChat();
  });
}

/** Whether `text` is the clear command. */
export function isClearCommand(text: string): boolean {
  return text.trim() === CHAT_CLEAR_COMMAND;
}

/** Send is enabled for any text while idle, and only for `/clear` while the chat answers. */
export function canSendChat(text: string, busy: boolean): boolean {
  if (text.trim() === "") return false;
  return !busy || isClearCommand(text);
}

/**
 * `"direct"` for ⌘⇧↵ on macOS and Ctrl+Shift+Enter elsewhere, `"send"` for ⌘↵ / Ctrl+Enter
 * (no Alt either way); null for other keys.
 */
export function composerShortcut(event: KeyboardEvent): "direct" | "send" | null {
  if (event.key !== "Enter" || !isModKey(event)) return null;
  return event.shiftKey ? "direct" : "send";
}

/** Whether a task was stopped while it waited at a gate: resume puts it back there. */
function stoppedAtGate(task: Pick<Task, "status" | "gate">): boolean {
  return task.status === "interrupted" && task.gate !== null;
}

/** Where the composer's direct send goes for the focused task, bypassing the agent. */
export interface ComposerRoute {
  label: string;
  /** `gate`: the draft answers the task's gate; `resume`: it resumes the task with the draft as guidance. */
  kind: "gate" | "resume";
}

/**
 * The composer's direct send for the focused task: the gate's message route, or resuming a failed
 * or interrupted task with the draft as guidance. Null when the task takes no direct send.
 */
export function composerRoute(
  task: Pick<Task, "status" | "gate" | "mode"> | undefined,
): ComposerRoute | null {
  if (!task) return null;
  const route = messageRoute(task);
  if (route) return { label: `${route.send} · ${route.to}`, kind: "gate" };
  if (task.status === "failed") return { label: "Retry with this", kind: "resume" };
  if (task.status === "interrupted" && !stoppedAtGate(task)) {
    return { label: "Resume with this", kind: "resume" };
  }
  return null;
}

/** Clearing asks first only while an answer is running, since it stops that answer. */
export function clearNeedsConfirm(busy: boolean): boolean {
  return busy;
}

/** The repo task an action names, if it is still there. */
export function chatActionTask(
  action: ChatAction,
  tasks: readonly Task[],
  repoId: string,
): Task | undefined {
  if (action.kind === "create-task") return undefined;
  return tasks.find((t) => t.id === action.taskId && t.repoId === repoId);
}

export type ChatActionAvailability =
  { kind: "applied" } | { kind: "available" } | { kind: "unavailable"; reason: string };

/** Whether an action can be applied now, from the live task; checked again by the server. */
export function actionAvailability(
  action: ChatAction,
  tasks: readonly Task[],
  repoId: string,
): ChatActionAvailability {
  if (action.appliedAt !== null) return { kind: "applied" };
  if (action.kind === "create-task") return { kind: "available" };
  const task = chatActionTask(action, tasks, repoId);
  if (!task) return { kind: "unavailable", reason: "This task no longer exists" };
  switch (action.kind) {
    case "message-task":
      if (messageRoute(task)) return { kind: "available" };
      return {
        kind: "unavailable",
        reason:
          task.status === "needs-you"
            ? "This task's gate takes no message"
            : "A task takes messages only while it waits for you at a gate",
      };
    case "answer-question":
      return task.status === "needs-you" && task.gate === "questions"
        ? { kind: "available" }
        : { kind: "unavailable", reason: "This task is not waiting on answers to its questions" };
    case "stop-task":
      return canStop(task)
        ? { kind: "available" }
        : { kind: "unavailable", reason: "Only a queued, running or waiting task can be stopped" };
    case "resume-task":
      if (task.status !== "interrupted" && task.status !== "failed") {
        return { kind: "unavailable", reason: "Only an interrupted or failed task can be resumed" };
      }
      if (action.message && stoppedAtGate(task)) {
        return {
          kind: "unavailable",
          reason: "Resume puts this task back at its gate; message it there",
        };
      }
      return { kind: "available" };
  }
}

export interface ChatActionSummary {
  /** What Apply does, e.g. "Request changes · planner". */
  label: string;
  /** The proposed backlog title, the task's title, or the raw id when the task is gone. */
  title: string;
  /** The description or message, when the action has one. */
  detail?: string;
}

/** What an action's card says, naming the live task rather than its id. */
export function chatActionSummary(action: ChatAction, task: Task | undefined): ChatActionSummary {
  switch (action.kind) {
    case "create-task":
      return { label: "New backlog task", title: action.title, detail: action.description };
    case "message-task": {
      const route = task ? messageRoute(task) : null;
      return {
        label: route ? `${route.send} · ${route.to}` : "Message task",
        title: task?.title ?? action.taskId,
        detail: action.message,
      };
    }
    case "answer-question":
      return {
        label: "Answer question",
        title: task?.title ?? action.taskId,
        detail: action.answer,
      };
    case "stop-task":
      return { label: "Stop task", title: task?.title ?? action.taskId };
    case "resume-task":
      if (!action.message) return { label: "Resume task", title: task?.title ?? action.taskId };
      return {
        label: task?.status === "failed" ? "Retry with guidance" : "Resume with guidance",
        title: task?.title ?? action.taskId,
        detail: action.message,
      };
  }
}

/**
 * The one card that gets the magenta needs button: the first available, unapplied `message-task`
 * or `answer-question` of the newest assistant message. Null when there is none.
 */
export function needsCardId(
  messages: readonly ChatMessage[],
  tasks: readonly Task[],
  repoId: string,
): string | null {
  const newest = messages.findLast((m) => m.role === "assistant");
  const card = newest?.actions.find(
    (a) =>
      (a.kind === "message-task" || a.kind === "answer-question") &&
      actionAvailability(a, tasks, repoId).kind === "available",
  );
  return card?.id ?? null;
}

/** The ids of items (chat messages, step-through comments) not seen yet: those fade in. */
export function freshIds<T extends { id: string }>(
  items: readonly T[],
  seen: ReadonlySet<string>,
): string[] {
  return items.filter((item) => !seen.has(item.id)).map((item) => item.id);
}

/**
 * The `create-task` card "Turn into task" adds to an assistant reply: the reply's first line,
 * without a heading marker, as title and the whole reply as description. Null for a blank reply.
 */
export function turnIntoTaskProposal(
  message: ChatMessage,
): Extract<ChatActionProposal, { kind: "create-task" }> | null {
  const description = message.text.trim();
  if (!description) return null;
  const firstLine = description.split("\n").find((line) => line.trim() !== "") ?? "";
  const line = firstLine.replace(/^\s*#{1,6}\s+/, "").trim();
  const capped = line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line;
  return { kind: "create-task", title: capped || "Untitled task", description };
}

/** Whether "Turn into task" shows: a non-blank reply without a card for the same text yet. */
export function canTurnIntoTask(message: ChatMessage): boolean {
  const proposal = turnIntoTaskProposal(message);
  if (!proposal) return false;
  return !message.actions.some(
    (a) => a.kind === "create-task" && a.description === proposal.description,
  );
}
