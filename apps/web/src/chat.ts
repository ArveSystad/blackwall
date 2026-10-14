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
import { isPlainKey, isTypingTarget, useWindowKeydown } from "./keyboard";

/**
 * The repo chat panel on the right. Whether it is open and its preferred width are remembered per
 * browser, like the theme; the conversation itself lives on the server.
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
    case "stop-task":
      return task.status === "queued" || task.status === "running"
        ? { kind: "available" }
        : { kind: "unavailable", reason: "Only a queued or running task can be stopped" };
    case "resume-task":
      return task.status === "interrupted" || task.status === "failed"
        ? { kind: "available" }
        : { kind: "unavailable", reason: "Only an interrupted or failed task can be resumed" };
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
    case "stop-task":
      return { label: "Stop task", title: task?.title ?? action.taskId };
    case "resume-task":
      return { label: "Resume task", title: task?.title ?? action.taskId };
  }
}

/**
 * The one card that gets the magenta needs button: the first available, unapplied `message-task`
 * of the newest assistant message. Null when there is none.
 */
export function needsCardId(
  messages: readonly ChatMessage[],
  tasks: readonly Task[],
  repoId: string,
): string | null {
  const newest = messages.findLast((m) => m.role === "assistant");
  const card = newest?.actions.find(
    (a) => a.kind === "message-task" && actionAvailability(a, tasks, repoId).kind === "available",
  );
  return card?.id ?? null;
}

/** The ids of messages not seen yet: those fade in. */
export function freshMessageIds(
  messages: readonly ChatMessage[],
  seen: ReadonlySet<string>,
): string[] {
  return messages.filter((m) => !seen.has(m.id)).map((m) => m.id);
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
