import {
  CHAT_CLEAR_COMMAND,
  type ChatAction,
  type ChatMessage,
  type ChatState,
  type RepoView,
  type Task,
} from "@blackwall/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  addChatAction,
  ApiError,
  createBacklogItem,
  markChatActionApplied,
  sendChat,
} from "../api";
import {
  actionAvailability,
  canSendChat,
  canTurnIntoTask,
  CHAT_PANEL_FALLBACK_MS,
  chatActionSummary,
  chatActionTask,
  chatPanelMotion,
  chatWidthBounds,
  clampChatWidth,
  clearNeedsConfirm,
  freshIds,
  isClearCommand,
  needsCardId,
  nextChatPresence,
  nextChatWidth,
  setChatOpen,
  setChatWidth,
  settleChatPresence,
  takeChatFocusRequest,
  turnIntoTaskProposal,
  useChatLayout,
  useViewportWidth,
  type ChatActionAvailability,
  type ChatActionSummary,
  type ChatPresence,
} from "../chat";
import { isModKey, isPlainKey, modKeyLabel } from "../keyboard";
import { cn } from "../lib/utils";
import { chatQuery, queryKeys, reposQuery, tasksQuery } from "../query";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { errorMessage } from "../settings-forms";
import { GATE_REASONS } from "../task-view";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { CheckIcon, CloseIcon } from "./icons";
import { Markdown } from "./Markdown";
import { StatusBadge } from "./StatusBadge";
import { answerGate, messageRoute, resume, stop } from "./task/actions";
import { useTaskAction } from "./task/use-task-action";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/field";
import { Kbd } from "./ui/kbd";

const TEXTAREA_ID = "chat-input";
/** Within this many px of the bottom, the log follows new messages. */
const FOLLOW_SLACK_PX = 24;
/** Longer create-task descriptions start clamped, with Show more. */
const LONG_DESCRIPTION_CHARS = 280;

/**
 * The repo chat on the right of every page: ask about the selected repo's code, backlog and tasks,
 * and apply the actions the agent proposes. Its width is the user's preference, clamped so the
 * main pane keeps room; it never overlays the page. It slides its width open and closed
 * (`CHAT_PANEL_MS`), so the main pane eases along.
 */
export function ChatPanel() {
  const layout = useChatLayout();
  const viewport = useViewportWidth();
  // A reload with the panel open shows it without sliding.
  const [presence, setPresence] = useState<ChatPresence>(() => (layout.open ? "open" : "closed"));
  const [seenOpen, setSeenOpen] = useState(layout.open);

  if (layout.open !== seenOpen) {
    setSeenOpen(layout.open);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setPresence(nextChatPresence(presence, layout.open, reduced));
  }

  // `transitionend` may never come (background tab, old engine), so a timeout settles the slide too.
  useEffect(() => {
    if (presence !== "opening" && presence !== "closing") return;
    const timer = window.setTimeout(() => setPresence(settleChatPresence), CHAT_PANEL_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [presence]);

  if (presence === "closed") return null;
  return (
    <OpenChatPanel
      preferred={layout.width}
      viewport={viewport}
      presence={presence}
      onSettled={() => setPresence(settleChatPresence)}
    />
  );
}

function OpenChatPanel({
  preferred,
  viewport,
  presence,
  onSettled,
}: {
  preferred: number;
  viewport: number;
  presence: ChatPresence;
  onSettled: () => void;
}) {
  const repos = useQuery(reposQuery);
  const repo = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = clampChatWidth(dragWidth ?? preferred, viewport);
  const closeButton = useRef<HTMLButtonElement>(null);
  const open = presence === "opening" || presence === "open";

  // Also runs when the panel is reopened mid-close, since it stayed mounted.
  useEffect(() => {
    if (!open || !takeChatFocusRequest()) return;
    const input = document.getElementById(TEXTAREA_ID);
    (input ?? closeButton.current)?.focus();
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Dialogs render in a portal: their keys bubble here through React but are not in the panel.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key !== "Escape" || event.defaultPrevented || !isPlainKey(event.nativeEvent)) return;
    event.preventDefault();
    if (event.target instanceof HTMLTextAreaElement) event.target.blur();
    else setChatOpen(false);
  }

  return (
    <aside
      aria-label="Chat"
      className="bw-chat relative h-full shrink-0 border-l border-border bg-sidebar"
      // A variable, not an inline width, so `@starting-style` in `.bw-chat` can apply.
      style={{ "--chat-w": `${width}px` } as CSSProperties}
      data-motion={chatPanelMotion(presence, dragWidth !== null) ?? undefined}
      inert={presence === "closing"}
      onKeyDown={onKeyDown}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "width") onSettled();
      }}
    >
      <ResizeHandle
        width={width}
        viewport={viewport}
        dragging={dragWidth !== null}
        onDrag={setDragWidth}
        onCommit={(next) => {
          setChatWidth(next);
          setDragWidth(null);
        }}
      />
      {/* Clipped and fixed-width while the aside slides, so the text never reflows. */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="bw-chat-content absolute inset-y-0 right-0 flex flex-col">
          {repo ? (
            <ChatBody key={repo.id} repo={repo} closeButton={closeButton} />
          ) : (
            <>
              <ChatHeader title="Chat" closeButton={closeButton} />
              <EmptyState title="No channel. Pick a repo to chat about it.">
                The chat answers about the repo selected in the top bar.
              </EmptyState>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The panel's left edge: drag it, or focus it and use the arrow keys, Home and End. */
function ResizeHandle({
  width,
  viewport,
  dragging,
  onDrag,
  onCommit,
}: {
  width: number;
  viewport: number;
  dragging: boolean;
  onDrag: (width: number | null) => void;
  onCommit: (width: number) => void;
}) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const bounds = chatWidthBounds(viewport);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, width };
    onDrag(width);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // The handle is the left edge: moving left widens the panel.
    const next = clampChatWidth(
      drag.current.startWidth + drag.current.startX - event.clientX,
      viewport,
    );
    drag.current.width = next;
    onDrag(next);
  }

  function onPointerEnd() {
    if (!drag.current) return;
    const { width: next, startWidth } = drag.current;
    drag.current = null;
    // A click without a drag keeps the stored preference, which may be wider than the window allows.
    if (next === startWidth) onDrag(null);
    else onCommit(next);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat"
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className="group absolute inset-y-0 -left-1 z-10 flex w-2 cursor-col-resize touch-none justify-center focus-visible:shadow-ring focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={(event) => {
        const next = nextChatWidth(event.key, width, viewport);
        if (next === null) return;
        event.preventDefault();
        setChatWidth(next);
      }}
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-border group-hover:w-0.5 group-hover:bg-cyan group-focus-visible:w-0.5 group-focus-visible:bg-cyan group-data-dragging:w-0.5 group-data-dragging:bg-cyan"
      />
    </div>
  );
}

function ChatHeader({
  title,
  closeButton,
  children,
}: {
  title: string;
  closeButton: RefObject<HTMLButtonElement | null>;
  children?: ReactNode;
}) {
  return (
    <header className="flex h-11 flex-none items-center gap-2 border-b border-border pr-2 pl-4">
      <h2 className="m-0 min-w-0 flex-1 truncate text-body font-semibold text-foreground-strong">
        {title}
      </h2>
      {children}
      <Button
        ref={closeButton}
        variant="ghost"
        size="icon-sm"
        aria-label="Close chat"
        title="Close chat (C)"
        onClick={() => setChatOpen(false)}
      >
        <CloseIcon />
      </Button>
    </header>
  );
}

/** Which messages fade in: those appended after the chat first rendered with data. */
interface FadeState {
  seen: ReadonlySet<string>;
  fading: ReadonlySet<string>;
}

function ChatBody({
  repo,
  closeButton,
}: {
  repo: RepoView;
  closeButton: RefObject<HTMLButtonElement | null>;
}) {
  const queryClient = useQueryClient();
  const chat = useQuery(chatQuery(repo.id));
  const tasks = useQuery(tasksQuery);
  const repoTasks = (tasks.data ?? []).filter((t) => t.repoId === repo.id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** Set while the Stop and clear dialog is open; `fromDraft` when `/clear` was typed. */
  const [confirmClear, setConfirmClear] = useState<{ fromDraft: boolean } | null>(null);
  const [fade, setFade] = useState<FadeState | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const state = chat.data;
  const messages = state?.messages;
  const busy = state?.busy ?? false;

  // Seed the seen ids on the first render with data, so history shows without fading.
  if (messages) {
    if (fade === null) {
      setFade({ seen: new Set(messages.map((m) => m.id)), fading: new Set() });
    } else {
      const fresh = freshIds(messages, fade.seen);
      if (fresh.length > 0) {
        setFade({
          seen: new Set([...fade.seen, ...fresh]),
          fading: new Set([...fade.fading, ...fresh]),
        });
      }
    }
  }

  const count = messages?.length ?? 0;
  const activity = state?.activity ?? null;
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
  }, [count, activity, busy]);

  function scrollToEnd() {
    following.current = true;
    end.current?.scrollIntoView({ block: "end" });
  }

  async function post(text: string): Promise<void> {
    setSending(true);
    setSendError(null);
    try {
      const next = await sendChat(repo.id, text);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repo.id), next);
      scrollToEnd();
    } catch (cause) {
      throw new Error(
        cause instanceof ApiError && cause.status === 409
          ? "The chat is still answering. Wait, or send /clear."
          : errorMessage(cause),
        { cause },
      );
    } finally {
      setSending(false);
    }
  }

  async function sendDraft() {
    if (!canSendChat(draft, busy) || sending) return;
    if (isClearCommand(draft) && clearNeedsConfirm(busy)) {
      setConfirmClear({ fromDraft: true });
      return;
    }
    try {
      await post(draft.trim());
      setDraft("");
    } catch (error) {
      setSendError(errorMessage(error));
    }
  }

  async function clear() {
    if (clearNeedsConfirm(busy)) {
      setConfirmClear({ fromDraft: false });
      return;
    }
    try {
      await post(CHAT_CLEAR_COMMAND);
    } catch (error) {
      setSendError(errorMessage(error));
    }
  }

  const canClear = busy || count > 0;
  const needsId = messages ? needsCardId(messages, repoTasks, repo.id) : null;

  return (
    <>
      <ChatHeader title={`Chat · ${repo.name}`} closeButton={closeButton}>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canClear || sending}
          onClick={() => void clear()}
        >
          Clear
        </Button>
      </ChatHeader>
      {chat.isPending ? (
        <EmptyState key="loading" role="status" title="Opening channel…" />
      ) : chat.isError ? (
        <EmptyState
          key="error"
          role="alert"
          title="Could not load the chat"
          onRetry={() => void chat.refetch()}
        >
          {chat.error.message}
        </EmptyState>
      ) : (
        <div
          ref={log}
          role="log"
          aria-live="polite"
          aria-label="Chat messages"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3"
          onScroll={() => {
            const el = log.current;
            if (el) {
              following.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
            }
          }}
        >
          {count === 0 && !busy && (
            <p className="m-0 text-meta text-muted-foreground">
              Channel open. Ask about this repo. Proposed actions wait for you to apply them.
            </p>
          )}
          {messages?.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              repoId={repo.id}
              tasks={repoTasks}
              needsId={needsId}
              fadeIn={fade?.fading.has(message.id) ?? false}
            />
          ))}
          <div ref={end} />
        </div>
      )}
      {busy && (
        <div className="flex flex-none items-center gap-2 border-t border-border px-4 py-1.5 text-meta text-cyan">
          <span
            className="size-1.5 flex-none rounded-full bg-running animate-pulse-running"
            aria-hidden="true"
          />
          <span className="mono min-w-0 truncate">{activity ?? "Thinking…"}</span>
        </div>
      )}
      <div role="status" className="sr-only">
        {busy ? "Thinking…" : ""}
      </div>
      <div className="flex flex-none flex-col gap-1.5 border-t border-border px-4 pt-2.5 pb-3">
        <form
          className="flex flex-col gap-1.5 rounded-lg border border-input bg-card p-1.5 focus-within:border-cyan focus-within:shadow-ring"
          onSubmit={(event) => {
            event.preventDefault();
            void sendDraft();
          }}
        >
          <label htmlFor={TEXTAREA_ID} className="sr-only">
            Message to the chat
          </label>
          <textarea
            ref={textarea}
            id={TEXTAREA_ID}
            rows={3}
            value={draft}
            placeholder={
              busy
                ? "Answering… type /clear to stop and start over"
                : "Ask about the code, backlog or tasks. /clear starts over."
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isModKey(event.nativeEvent)) {
                event.preventDefault();
                void sendDraft();
              }
            }}
            className="min-h-0 w-full resize-none bg-transparent px-1 text-body text-foreground-strong outline-none focus-visible:shadow-none"
          />
          <div className="flex items-center justify-end gap-2">
            <Kbd aria-hidden="true">{modKeyLabel("↵")}</Kbd>
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={!canSendChat(draft, busy) || sending || chat.isPending}
            >
              Send
            </Button>
          </div>
        </form>
        {sendError && <ErrorText>{sendError}</ErrorText>}
      </div>
      {confirmClear && (
        <ConfirmDialog
          title="Stop and clear the chat?"
          confirmLabel="Stop and clear"
          confirmVariant="destructive"
          onConfirm={async () => {
            await post(CHAT_CLEAR_COMMAND);
            if (confirmClear.fromDraft) setDraft("");
          }}
          onClose={() => setConfirmClear(null)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            textarea.current?.focus();
          }}
        >
          The answer in progress is stopped and the conversation is dropped.
        </ConfirmDialog>
      )}
    </>
  );
}

function MessageItem({
  message,
  repoId,
  tasks,
  needsId,
  fadeIn,
}: {
  message: ChatMessage;
  repoId: string;
  tasks: readonly Task[];
  needsId: string | null;
  fadeIn: boolean;
}) {
  const fade = fadeIn && "animate-fade-in";
  switch (message.role) {
    case "user":
      return (
        <div
          className={cn(
            "max-w-[85%] self-end rounded-lg bg-muted px-3 py-2 text-body break-words whitespace-pre-wrap text-foreground-strong",
            fade,
          )}
        >
          <span className="sr-only">You: </span>
          {message.text}
        </div>
      );
    case "error":
      return (
        <p className={cn("m-0 text-body break-words text-destructive", fade)}>
          <span className="font-semibold">Error: </span>
          {message.text}
        </p>
      );
    case "assistant":
      return (
        <div className={cn("flex min-w-0 flex-col gap-2", fade)}>
          <Markdown className="break-words">{message.text}</Markdown>
          {message.actions.map((action) => (
            <ActionCard
              key={action.id}
              action={action}
              repoId={repoId}
              tasks={tasks}
              needs={action.id === needsId}
            />
          ))}
          {canTurnIntoTask(message) && <TurnIntoTaskButton message={message} repoId={repoId} />}
        </div>
      );
  }
}

/** Adds a pre-filled `create-task` card to an assistant reply; the card applies like any other. */
function TurnIntoTaskButton({ message, repoId }: { message: ChatMessage; repoId: string }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const proposal = turnIntoTaskProposal(message);
    if (!proposal) return;
    setPending(true);
    setError(null);
    try {
      const next = await addChatAction(repoId, message.id, proposal);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repoId), next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 self-start">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => void onClick()}>
        {pending ? "Adding…" : "Turn into task"}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/**
 * A proposed action: what Apply does, then Apply. Applying runs the action through its existing
 * endpoint, then marks it applied on the server so it stays Done. If only the mark failed, Retry
 * repeats the mark and never the action.
 */
function ActionCard({
  action,
  repoId,
  tasks,
  needs,
}: {
  action: ChatAction;
  repoId: string;
  tasks: readonly Task[];
  needs: boolean;
}) {
  const task = chatActionTask(action, tasks, repoId);
  const availability = actionAvailability(action, tasks, repoId);
  const summary = chatActionSummary(action, task);
  if (action.kind === "create-task") {
    return (
      <CreateTaskCard
        action={action}
        repoId={repoId}
        summary={summary}
        availability={availability}
      />
    );
  }
  if (!task) {
    return (
      <CardShell
        summary={summary}
        title={<span className="mono text-muted-foreground">{summary.title}</span>}
        availability={availability}
        apply={{ variant: "default", pending: false, error: null, run: async () => false }}
        repoId={repoId}
        actionId={action.id}
      />
    );
  }
  return (
    <TaskActionCard
      action={action}
      task={task}
      repoId={repoId}
      summary={summary}
      availability={availability}
      needs={needs}
    />
  );
}

type TaskChatAction = Exclude<ChatAction, { kind: "create-task" }>;

function TaskActionCard({
  action,
  task,
  repoId,
  summary,
  availability,
  needs,
}: {
  action: TaskChatAction;
  task: Task;
  repoId: string;
  summary: ChatActionSummary;
  availability: ChatActionAvailability;
  needs: boolean;
}) {
  const taskAction = useTaskAction(task);

  async function run(): Promise<boolean> {
    switch (action.kind) {
      case "message-task": {
        const route = messageRoute(task);
        if (!route) return false;
        const done = await answerGate(
          taskAction,
          task,
          { decision: route.decision, message: action.message },
          route.send,
        );
        return done !== undefined;
      }
      case "stop-task":
        return (await stop(taskAction, task)) !== undefined;
      case "resume-task":
        return (await resume(taskAction, task)) !== undefined;
    }
  }

  const variant =
    action.kind === "stop-task"
      ? "destructive-ghost"
      : action.kind === "message-task" && needs
        ? "needs"
        : "default";

  return (
    <CardShell
      summary={summary}
      title={
        <Link
          to="/tasks/$taskId"
          params={{ taskId: task.id }}
          className="min-w-0 font-semibold break-words text-foreground-strong"
        >
          {task.title}
        </Link>
      }
      badges={
        <>
          <StatusBadge status={task.status} />
          {action.kind === "message-task" && task.gate && (
            <span className="text-meta text-needs">{GATE_REASONS[task.gate]}</span>
          )}
        </>
      }
      detail={
        action.kind === "message-task" && (
          <p className="m-0 text-body break-words whitespace-pre-wrap text-foreground">
            {action.message}
          </p>
        )
      }
      availability={availability}
      apply={{ variant, pending: taskAction.pending, error: taskAction.error, run }}
      repoId={repoId}
      actionId={action.id}
    />
  );
}

function CreateTaskCard({
  action,
  repoId,
  summary,
  availability,
}: {
  action: Extract<ChatAction, { kind: "create-task" }>;
  repoId: string;
  summary: ChatActionSummary;
  availability: ChatActionAvailability;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const long = action.description.length > LONG_DESCRIPTION_CHARS;

  async function run(): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await createBacklogItem(repoId, {
        origin: { kind: "free-text" },
        title: action.title,
        freeText: action.description,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <CardShell
      summary={summary}
      title={
        <span className="min-w-0 font-semibold break-words text-foreground-strong">
          {action.title}
        </span>
      }
      detail={
        <div className="flex flex-col items-start gap-1">
          <div className={cn("w-full", !expanded && "line-clamp-4")}>
            <Markdown className="break-words">{action.description}</Markdown>
          </div>
          {long && (
            <button
              type="button"
              aria-expanded={expanded}
              className="cursor-pointer bg-transparent p-0 text-meta text-primary hover:underline"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      }
      availability={availability}
      apply={{ variant: "default", pending, error, run }}
      repoId={repoId}
      actionId={action.id}
    />
  );
}

/** How a card applies its action; `run` resolves true when the action succeeded. */
interface ApplyAction {
  variant: "default" | "needs" | "destructive-ghost";
  pending: boolean;
  error: string | null;
  run: () => Promise<boolean>;
}

function CardShell({
  summary,
  title,
  badges,
  detail,
  availability,
  apply,
  repoId,
  actionId,
}: {
  summary: ChatActionSummary;
  title: ReactNode;
  badges?: ReactNode;
  detail?: ReactNode;
  availability: ChatActionAvailability;
  apply: ApplyAction;
  repoId: string;
  actionId: string;
}) {
  const queryClient = useQueryClient();
  /** The action ran but the mark has not stuck yet: Retry repeats only the mark. */
  const [ran, setRan] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  async function mark() {
    setMarking(true);
    setMarkError(null);
    try {
      const next = await markChatActionApplied(repoId, actionId);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repoId), next);
    } catch (cause) {
      setMarkError(errorMessage(cause));
    } finally {
      setMarking(false);
    }
  }

  async function onApply() {
    if (ran) return mark();
    if (!(await apply.run())) return;
    setRan(true);
    await mark();
  }

  const pending = apply.pending || marking;
  const unavailable = availability.kind === "unavailable" && !ran ? availability.reason : null;
  const error = markError ?? (ran ? null : apply.error);

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-meta text-muted-foreground">{summary.label}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {title}
          {badges}
        </div>
        {detail}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {availability.kind === "applied" ? (
          <span className="inline-flex items-center gap-1.5 text-meta font-medium text-done">
            <CheckIcon size="sm" />
            Done
          </span>
        ) : (
          <>
            <Button
              size="sm"
              variant={apply.variant}
              disabled={pending || unavailable !== null}
              aria-label={`${ran ? "Retry" : "Apply"}: ${summary.label} ${summary.title}`}
              onClick={() => void onApply()}
            >
              {pending ? "Applying…" : ran ? "Retry" : "Apply"}
            </Button>
            {unavailable && <span className="text-meta text-muted-foreground">{unavailable}</span>}
          </>
        )}
      </div>
      {error && availability.kind !== "applied" && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
