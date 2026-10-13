import type { PrMode, Task, TaskOrigin } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { MissingCredentialError, createBacklogItem } from "../api";
import { useWithCredential } from "../credentials";
import { originKey } from "../inbox";
import { queryKeys, taskQuery } from "../query";
import { errorMessage } from "../settings-forms";
import { Button } from "./ui/button";
import { ErrorText } from "./ui/field";

/**
 * Adds the item with defaults to its repo's backlog; the server starts it at
 * once when that backlog runs. The row then links to what was created.
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

  async function work() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const created = await withCredential(
        { label: "Work on task", target: originKey({ origin }) },
        () => createBacklogItem(repoId, { origin, mode, start: true }),
      );
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
        Work on task
      </Button>
      {error && <ErrorText className="max-w-60 text-right">{error}</ErrorText>}
    </span>
  );
}
