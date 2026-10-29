import type { RepoView } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
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
  CHAT_INPUT_ID,
  CHAT_PANEL_FALLBACK_MS,
  chatPanelMotion,
  chatWidthBounds,
  clampChatWidth,
  nextChatPresence,
  nextChatWidth,
  setChatOpen,
  setChatWidth,
  settleChatPresence,
  takeChatFocusRequest,
  useChatLayout,
  useViewportWidth,
  type ChatPresence,
} from "../chat";
import { isPlainKey } from "../keyboard";
import { reposQuery } from "../query";
import { resolveSelectedRepo, useSelectedRepoId } from "../selected-repo";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatBusyLine, ChatLog, ClearChatDialog } from "./chat/ChatLog";
import { useChatConversation } from "./chat/use-chat-conversation";
import { EmptyState } from "./EmptyState";
import { CloseIcon } from "./icons";
import { Button } from "./ui/button";

/**
 * The chat on the right of every page: ask about the selected repo's code, backlog and tasks,
 * and apply the actions the agent proposes. It is always the repo chat of the repo picked in the
 * top bar, task pages included; a task's own conversation is its task channel, on the task page
 * (`TaskChatPane`). Its width is the user's preference, clamped so the
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
  const selected = resolveSelectedRepo(useSelectedRepoId(), repos.data);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = clampChatWidth(dragWidth ?? preferred, viewport);
  const closeButton = useRef<HTMLButtonElement>(null);
  const open = presence === "opening" || presence === "open";

  // Also runs when the panel is reopened mid-close, since it stayed mounted.
  useEffect(() => {
    if (!open || !takeChatFocusRequest()) return;
    const input = document.getElementById(CHAT_INPUT_ID);
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
          {selected ? (
            <RepoChat key={selected.id} repo={selected} closeButton={closeButton} />
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

/** The selected repo's chat: never task-scoped, so it has no direct send. */
function RepoChat({
  repo,
  closeButton,
}: {
  repo: RepoView;
  closeButton: RefObject<HTMLButtonElement | null>;
}) {
  const conversation = useChatConversation(repo, undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { canClear, sending, clear } = conversation;

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
      <ChatLog conversation={conversation} label="Chat messages" />
      <ChatBusyLine conversation={conversation} />
      <ChatComposer
        conversation={conversation}
        inputId={CHAT_INPUT_ID}
        placeholder="Ask about the code, backlog or tasks. /clear starts over."
        textareaRef={textarea}
      />
      <ClearChatDialog conversation={conversation} textareaRef={textarea} />
    </>
  );
}
