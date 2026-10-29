import { CHAT_CLEAR_COMMAND } from "@blackwall/shared";
import type { RefObject } from "react";
import { ConfirmDialog } from "../ConfirmDialog";
import { EmptyState } from "../EmptyState";
import { DraftMessage, MessageItem } from "./ChatMessages";
import type { ChatConversation } from "./use-chat-conversation";

/** A chat's messages, following new ones unless the user scrolled up; or its loading or error state. */
export function ChatLog({
  conversation,
  label,
}: {
  conversation: ChatConversation;
  /** The log's accessible name; distinct when the side panel and a task channel both show. */
  label: string;
}) {
  const { chat, log, end, onScroll, messages, busy, liveDraft, count, fade, onGrow } = conversation;
  const { repo, taskId, repoTasks, needsId } = conversation;

  if (chat.isPending) return <EmptyState key="loading" role="status" title="Opening channel…" />;
  if (chat.isError) {
    return (
      <EmptyState
        key="error"
        role="alert"
        title="Could not load the chat"
        onRetry={() => void chat.refetch()}
      >
        {chat.error.message}
      </EmptyState>
    );
  }
  return (
    <div
      ref={log}
      role="log"
      aria-live="polite"
      aria-label={label}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3"
      onScroll={onScroll}
    >
      {count === 0 && !busy && liveDraft === null && (
        <p className="m-0 text-meta text-muted-foreground">
          Channel open. Ask about this {taskId ? "task" : "repo"}. Proposed actions wait for you to
          apply them.
        </p>
      )}
      {messages?.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          repoId={repo.id}
          taskId={taskId}
          tasks={repoTasks}
          needsId={needsId}
          fadeIn={fade?.fading.has(message.id) ?? false}
          streamFrom={fade?.streamFrom.get(message.id) ?? null}
          onGrow={onGrow}
        />
      ))}
      {liveDraft !== null && (
        <DraftMessage text={liveDraft} from={fade?.draftFrom ?? 0} onGrow={onGrow} />
      )}
      <div ref={end} />
    </div>
  );
}

/** The busy activity line while the chat answers, and its screen reader status. */
export function ChatBusyLine({ conversation }: { conversation: ChatConversation }) {
  const { busy, flavour } = conversation;
  return (
    <>
      {busy && (
        <div
          className="flex flex-none items-center gap-2 border-t border-border px-4 py-1.5 text-meta text-cyan"
          aria-hidden="true"
        >
          <span
            className="size-1.5 flex-none rounded-full bg-running animate-pulse-running"
            aria-hidden="true"
          />
          <span className="mono min-w-0 truncate">{flavour}</span>
        </div>
      )}
      <div role="status" className="sr-only">
        {busy ? "Thinking…" : ""}
      </div>
    </>
  );
}

/** Asks before clearing a chat that is still answering, since clearing stops the answer. */
export function ClearChatDialog({
  conversation,
  textareaRef,
}: {
  conversation: ChatConversation;
  /** Focused again when the dialog closes. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { confirmClear, setConfirmClear, post, clearDraft } = conversation;
  if (!confirmClear) return null;
  return (
    <ConfirmDialog
      title="Stop and clear the chat?"
      confirmLabel="Stop and clear"
      confirmVariant="destructive"
      onConfirm={async () => {
        await post(CHAT_CLEAR_COMMAND);
        if (confirmClear.fromDraft) clearDraft();
      }}
      onClose={() => setConfirmClear(null)}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        textareaRef.current?.focus();
      }}
    >
      The answer in progress is stopped and the conversation is dropped.
    </ConfirmDialog>
  );
}
