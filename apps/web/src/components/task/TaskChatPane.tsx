import type { RepoView, Task, TaskStatus } from "@blackwall/shared";
import { useQuery } from "@tanstack/react-query";
import { useRef, type KeyboardEvent } from "react";
import { TASK_CHAT_INPUT_ID, toggleTaskChat, useTaskChatLayout } from "../../chat";
import { isPlainKey } from "../../keyboard";
import { cn } from "../../lib/utils";
import { reposQuery } from "../../query";
import { ChatComposer } from "../chat/ChatComposer";
import { ChatBusyLine, ChatLog, ClearChatDialog } from "../chat/ChatLog";
import { useChatConversation } from "../chat/use-chat-conversation";
import { ChevronDownIcon, ChevronRightIcon } from "../icons";
import { StatusBadge } from "../StatusBadge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

/** The channel's frame line, tinted with the task's status; literal classes so Tailwind sees them. */
const STATUS_LINE: Record<TaskStatus, string> = {
  queued: "[--bw-chamfer-line:var(--border-strong)]",
  running: "[--bw-chamfer-line:color-mix(in_oklab,var(--st-running)_40%,transparent)]",
  "needs-you": "[--bw-chamfer-line:color-mix(in_oklab,var(--st-needs)_40%,transparent)]",
  interrupted: "[--bw-chamfer-line:color-mix(in_oklab,var(--st-interrupted)_40%,transparent)]",
  failed: "[--bw-chamfer-line:color-mix(in_oklab,var(--st-failed)_40%,transparent)]",
  done: "[--bw-chamfer-line:color-mix(in_oklab,var(--st-done)_40%,transparent)]",
};

const HISTORY_ID = "task-chat-history";

/**
 * A task page's own chat, between the banner and the tabs: the agent knows the task in full, and
 * the composer can send the draft straight to the task (its gate, or resuming it with the draft as
 * guidance). The composer always shows; only the history folds, remembered per browser.
 */
export function TaskChatPane({ task }: { task: Task }) {
  const repos = useQuery(reposQuery);
  const repo = repos.data?.find((r) => r.id === task.repoId);
  // Nothing while the repos load, or for a repo that is not listed.
  if (!repo) return null;
  return <TaskChannel key={task.id} repo={repo} task={task} />;
}

function TaskChannel({ repo, task }: { repo: RepoView; task: Task }) {
  const { open } = useTaskChatLayout();
  const conversation = useChatConversation(repo, task.id);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { messages, count, canClear, sending, clear } = conversation;
  const latest = open ? undefined : messages?.findLast((m) => m.role === "assistant");

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // Dialogs render in a portal: their keys bubble here through React but are not in the pane.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key !== "Escape" || event.defaultPrevented || !isPlainKey(event.nativeEvent)) return;
    if (!(event.target instanceof HTMLTextAreaElement)) return;
    event.preventDefault();
    event.target.blur();
  }

  return (
    <div className="mx-5 mt-3">
      <section
        aria-label="Task channel"
        className={cn("bw-chamfer flex flex-col bg-sidebar", STATUS_LINE[task.status])}
        onKeyDown={onKeyDown}
      >
        <header className="flex min-w-0 items-center gap-2 px-4 pt-2 pb-1.5">
          <h2 className="m-0 text-label text-muted-foreground uppercase">Task channel</h2>
          <Kbd aria-hidden="true">M</Kbd>
          <StatusBadge status={task.status} />
          <span className="mono text-[11px] text-faint">
            {count} {count === 1 ? "message" : "messages"}
          </span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={HISTORY_ID}
            onClick={() => toggleTaskChat()}
          >
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {open ? "Hide history" : "Show history"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!canClear || sending}
            onClick={() => void clear()}
          >
            Clear
          </Button>
        </header>
        <div id={HISTORY_ID} className={cn(open && "flex h-[min(40vh,360px)] min-h-40 flex-col")}>
          {open ? (
            <ChatLog conversation={conversation} label="Task channel messages" />
          ) : (
            latest && (
              <p className="m-0 truncate px-4 pb-1.5 text-meta text-muted-foreground">
                {latest.text}
              </p>
            )
          )}
        </div>
        <ChatBusyLine conversation={conversation} />
        <ChatComposer
          conversation={conversation}
          inputId={TASK_CHAT_INPUT_ID}
          label="Message to the task channel"
          placeholder="Ask about this task… /clear starts over."
          rows={2}
          focusTask={task}
          textareaRef={textarea}
        />
        <ClearChatDialog conversation={conversation} textareaRef={textarea} />
      </section>
    </div>
  );
}
