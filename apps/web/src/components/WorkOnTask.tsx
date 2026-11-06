import type { PrMode, Task, TaskOrigin } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MissingCredentialError, createBacklogItem } from "../api";
import { useWithCredential } from "../credentials";
import { originKey } from "../inbox";
import { queryKeys, taskQuery } from "../query";
import { errorMessage } from "../settings-forms";
import { SpinnerIcon } from "./icons";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/field";
import { useStackChoice } from "./use-stack-choice";

/**
 * Adds the item with defaults to its repo's backlog; the server starts it at
 * once when that backlog runs. The row then links to what was created. A PR
 * of a stack first asks whether to review the whole stack.
 */
export function WorkOnTask({
  origin,
  mode,
  repoId,
  title,
}: {
  origin: TaskOrigin;
  mode: PrMode | null;
  repoId: string;
  title?: string;
}) {
  const queryClient = useQueryClient();
  const withCredential = useWithCredential();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { askStack, dialog } = useStackChoice();

  async function work() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const created = await withCredential(
        { label: "Work on task", target: originKey({ origin }) },
        async () => {
          const stackSiblings = await askStack(origin);
          if (stackSiblings === "cancel") return null;
          return createBacklogItem(repoId, {
            origin,
            mode,
            start: true,
            ...(stackSiblings === undefined ? {} : { stackSiblings }),
          });
        },
      );
      if (!created) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.backlog(repoId) });
      if (created.taskId) {
        const task = await queryClient.fetchQuery(taskQuery(created.taskId));
        queryClient.setQueryData<Task[]>(queryKeys.tasks, (tasks) =>
          tasks && !tasks.some((t) => t.id === task.id) ? [...tasks, task] : tasks,
        );
      }
    } catch (cause) {
      setError(
        cause instanceof MissingCredentialError ? "Cancelled: no token saved" : errorMessage(cause),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        title={title}
        onClick={() => void work()}
      >
        {pending && (
          <SpinnerIcon
            className="animate-spin"
            role="status"
            aria-hidden={false}
            aria-label="Adding"
          />
        )}
        Work on task
      </Button>
      {error && <ErrorText className="max-w-60 text-right">{error}</ErrorText>}
      {dialog}
    </span>
  );
}
