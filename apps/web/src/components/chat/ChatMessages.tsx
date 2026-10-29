import type { ChatMessage, ChatState, Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { addChatAction } from "../../api";
import { canTurnIntoTask, turnIntoTaskProposal } from "../../chat";
import { cn } from "../../lib/utils";
import { queryKeys } from "../../query";
import { errorMessage } from "../../settings-forms";
import { Markdown } from "../Markdown";
import { Button } from "../ui/button";
import { ErrorText } from "../ui/field";
import { useChatStream } from "../use-chat-stream";
import { ActionCard } from "./ActionCards";

/**
 * The reply as the agent writes it, revealed word by word. Hidden from screen readers: the log
 * announces the final reply once instead of every chunk.
 */
export function DraftMessage({
  text,
  from,
  onGrow,
}: {
  text: string;
  /** How much shows at once when the bubble mounts. */
  from: number;
  onGrow: () => void;
}) {
  const [initial] = useState(from);
  const frame = useChatStream(text, { from: initial, play: true });
  const shown = frame ?? text;
  useEffect(() => onGrow(), [shown, onGrow]);
  return (
    <div aria-hidden="true" className="flex min-w-0 flex-col gap-2">
      <Markdown className="break-words">{shown}</Markdown>
    </div>
  );
}

export function MessageItem({
  message,
  repoId,
  taskId,
  tasks,
  needsId,
  fadeIn,
  streamFrom,
  onGrow,
}: {
  message: ChatMessage;
  repoId: string;
  /** The task whose conversation this is; undefined for the repo chat. */
  taskId: string | undefined;
  tasks: readonly Task[];
  needsId: string | null;
  fadeIn: boolean;
  /** For a fresh assistant reply, where its reveal starts; null shows it at once. */
  streamFrom: number | null;
  onGrow: () => void;
}) {
  const fade = fadeIn && "animate-fade-in";
  switch (message.role) {
    case "user":
      return (
        <div
          className={cn(
            "bw-chamfer max-w-[85%] self-end bg-muted px-3 py-2 text-body break-words whitespace-pre-wrap text-foreground-strong [--bw-chamfer-line:transparent]",
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
        <AssistantMessage
          message={message}
          repoId={repoId}
          taskId={taskId}
          tasks={tasks}
          needsId={needsId}
          streamFrom={streamFrom}
          onGrow={onGrow}
        />
      );
  }
}

/**
 * An assistant reply and its action cards. A fresh one reveals word by word from `streamFrom`;
 * meanwhile screen readers get the full reply once, and the cards wait until it is all out.
 */
function AssistantMessage({
  message,
  repoId,
  taskId,
  tasks,
  needsId,
  streamFrom,
  onGrow,
}: {
  message: ChatMessage;
  repoId: string;
  taskId: string | undefined;
  tasks: readonly Task[];
  needsId: string | null;
  streamFrom: number | null;
  onGrow: () => void;
}) {
  const frame = useChatStream(message.text, { from: streamFrom ?? 0, play: streamFrom !== null });
  useEffect(() => onGrow(), [frame, onGrow]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {frame !== null && (
        <div aria-hidden="true">
          <Markdown className="break-words">{frame}</Markdown>
        </div>
      )}
      <Markdown className={cn("break-words", frame !== null && "sr-only")}>{message.text}</Markdown>
      {frame === null &&
        message.actions.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            repoId={repoId}
            taskId={taskId}
            tasks={tasks}
            needs={action.id === needsId}
          />
        ))}
      {frame === null && canTurnIntoTask(message) && (
        <TurnIntoTaskButton message={message} repoId={repoId} taskId={taskId} />
      )}
    </div>
  );
}

/** Adds a pre-filled `create-task` card to an assistant reply; the card applies like any other. */
function TurnIntoTaskButton({
  message,
  repoId,
  taskId,
}: {
  message: ChatMessage;
  repoId: string;
  taskId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    const proposal = turnIntoTaskProposal(message);
    if (!proposal) return;
    setPending(true);
    setError(null);
    try {
      const next = await addChatAction(repoId, message.id, proposal, taskId);
      queryClient.setQueryData<ChatState>(queryKeys.chat(repoId, taskId), next);
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
