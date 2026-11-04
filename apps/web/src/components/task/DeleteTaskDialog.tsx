import type { BacklogItemView, Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { deleteTask } from "../../api";
import { clearTaskDrafts } from "../../drafts";
import { forgetTask } from "../../live";
import { queryKeys } from "../../query";
import { deleteTaskCopy } from "../../task-view";
import { ConfirmDialog } from "../ConfirmDialog";
import { useArchive } from "../use-archive-launches";

/**
 * Confirms deleting a task and says what goes with it. On success the task
 * leaves the cache at once (the `task.removed` event does the same for every
 * other tab), and an open task view returns to the inbox, while the task's
 * inbox and Backlog rows crumble out red.
 */
export function DeleteTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const queryClient = useQueryClient();
  const launch = useArchive();
  const copy = deleteTaskCopy(task);
  const branch = task.branch && copy.includes(task.branch) ? task.branch : null;
  const [before, after] = branch ? copy.split(branch, 2) : [copy, ""];

  return (
    <ConfirmDialog
      title="Delete task"
      confirmLabel="Delete task"
      onClose={onClose}
      onConfirm={async () => {
        await deleteTask(task.id);
        // Read before forgetTask refetches the backlog, which unlinks the item.
        const itemId = queryClient
          .getQueryData<BacklogItemView[]>(queryKeys.backlog(task.repoId))
          ?.find((item) => item.taskId === task.id)?.id;
        launch.remove(task, itemId);
        clearTaskDrafts(task.id);
        forgetTask(queryClient, task.id);
      }}
    >
      {before}
      {branch && <span className="mono text-foreground">{branch}</span>}
      {after}
    </ConfirmDialog>
  );
}
