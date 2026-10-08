import type { Task } from "@blackwall/shared";
import { useRef } from "react";
import { isModKey, modKeyLabel } from "../../keyboard";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { answerGate, messageRoute } from "./actions";
import type { TaskAction } from "./use-task-action";

function idlePlaceholder(task: Task): string {
  if (task.status === "needs-you" && task.gate === "questions") {
    return "Answer the open questions in the Grill tab.";
  }
  if (task.status === "running" || task.status === "queued") {
    return "Instructions can be sent when the task next stops for you.";
  }
  if (task.status === "done") return "The task is done.";
  return "Resume the task to continue.";
}

/** The input bar under the task view: a free-text instruction for the agent the next stage runs. */
export function InputBar({
  task,
  action,
  draft,
  onDraft,
}: {
  task: Task;
  action: TaskAction;
  draft: string;
  onDraft: (text: string) => void;
}) {
  const route = messageRoute(task);
  const input = useRef<HTMLInputElement>(null);
  const canSend = route !== null && draft.trim() !== "" && !action.pending;

  async function send() {
    if (!route || !canSend) return;
    const done = await answerGate(
      action,
      task,
      { decision: route.decision, message: draft.trim() },
      route.send,
    );
    if (done) onDraft("");
  }

  return (
    <div className="border-t border-border bg-sidebar px-5 pt-2.5 pb-3.5">
      <form
        className="flex items-center gap-2 rounded-lg border border-input bg-card py-1 pr-1 pl-2.5 focus-within:border-cyan focus-within:shadow-ring"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {route && (
          <span className="text-meta whitespace-nowrap text-muted-foreground">to {route.to}</span>
        )}
        <label className="flex min-w-0 flex-1">
          <span className="sr-only">Message to the task</span>
          <input
            ref={input}
            id="task-input-bar"
            type="text"
            disabled={!route}
            value={draft}
            placeholder={route ? route.placeholder : idlePlaceholder(task)}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && isModKey(event.nativeEvent)) {
                event.preventDefault();
                void send();
              } else if (event.key === "Escape") {
                event.currentTarget.blur();
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-body text-foreground-strong outline-none focus-visible:shadow-none disabled:cursor-not-allowed"
          />
        </label>
        {route && <Kbd aria-hidden="true">{modKeyLabel("↵")}</Kbd>}
        <Button size="sm" variant="primary" type="submit" disabled={!canSend}>
          {route?.send ?? "Send"}
        </Button>
      </form>
    </div>
  );
}
