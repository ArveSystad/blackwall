import type { Task } from "@blackwall/shared";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { canSendChat, composerRoute, composerShortcut, type ComposerRoute } from "../../chat";
import { modKeyLabel } from "../../keyboard";
import { answerGate, messageRoute, resume } from "../task/actions";
import { useTaskAction } from "../task/use-task-action";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";
import { Kbd } from "../ui/kbd";
import type { ChatConversation } from "./use-chat-conversation";

/**
 * A chat's composer: ⌘↵ sends to the chat. With `focusTask` it also offers the task's direct
 * send (⌘⇧↵), when the task takes one.
 */
export function ChatComposer({
  conversation,
  inputId,
  label = "Message to the chat",
  placeholder,
  rows = 3,
  focusTask,
  before,
  textareaRef,
}: {
  conversation: ChatConversation;
  inputId: string;
  /** The textarea's accessible name. */
  label?: string;
  /** Shown while idle; a busy chat says how to stop instead. */
  placeholder: string;
  rows?: number;
  /** The task the draft can go to directly, bypassing the agent. */
  focusTask?: Task;
  /** A strip above the form. */
  before?: ReactNode;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const { chat, draft, setDraft, clearDraft, busy, sending, sendError, setSendError, sendDraft } =
    conversation;
  const ownTextarea = useRef<HTMLTextAreaElement>(null);
  const textarea = textareaRef ?? ownTextarea;
  const directButton = useRef<HTMLButtonElement>(null);
  const direct = composerRoute(focusTask);

  return (
    <div className="flex flex-none flex-col gap-1.5 border-t border-border px-4 pt-2.5 pb-3">
      {before}
      <form
        className="bw-chamfer bw-chamfer-focus-within flex flex-col gap-1.5 bg-card p-1.5 [--bw-chamfer-line:var(--border-strong)]"
        onSubmit={(event) => {
          event.preventDefault();
          void sendDraft();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <textarea
          ref={textarea}
          id={inputId}
          rows={rows}
          value={draft}
          placeholder={busy ? "Answering… type /clear to stop and start over" : placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            const shortcut = composerShortcut(event.nativeEvent);
            if (shortcut === "direct") {
              event.preventDefault();
              const button = directButton.current;
              if (button && !button.disabled) button.click();
            } else if (shortcut === "send") {
              event.preventDefault();
              void sendDraft();
            }
          }}
          className="min-h-0 w-full resize-none bg-transparent px-1 text-body text-foreground-strong outline-none focus-visible:shadow-none"
        />
        <div className="flex items-center justify-end gap-2">
          {focusTask && direct && (
            <DirectSend
              key={focusTask.id}
              task={focusTask}
              route={direct}
              draft={draft}
              buttonRef={directButton}
              onStart={() => setSendError(null)}
              onSent={clearDraft}
              onError={setSendError}
            />
          )}
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
  );
}

/**
 * The composer's direct send: the draft goes as it is to the focused task, answering its gate or
 * resuming it with the draft as guidance, without asking the agent. Not stored in the chat.
 */
function DirectSend({
  task,
  route,
  draft,
  buttonRef,
  onStart,
  onSent,
  onError,
}: {
  task: Task;
  route: ComposerRoute;
  draft: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onStart: () => void;
  onSent: () => void;
  onError: (error: string) => void;
}) {
  const action = useTaskAction(task);

  useEffect(() => {
    if (action.error) onError(action.error);
  }, [action.error, onError]);

  async function send() {
    const message = draft.trim();
    const gate = messageRoute(task);
    if (!message || action.pending) return;
    onStart();
    const done =
      route.kind === "resume"
        ? await resume(action, task, message)
        : gate
          ? await answerGate(action, task, { decision: gate.decision, message }, gate.send)
          : undefined;
    if (done) onSent();
  }

  return (
    <>
      <Kbd aria-hidden="true">{modKeyLabel("⇧↵")}</Kbd>
      <Button
        ref={buttonRef}
        size="sm"
        variant="ghost"
        type="button"
        disabled={!draft.trim() || action.pending}
        onClick={() => void send()}
      >
        {action.pending ? "Sending…" : route.label}
      </Button>
    </>
  );
}
