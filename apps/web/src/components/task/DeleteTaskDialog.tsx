import type { Task } from "@blackwall/shared";
import { useQueryClient } from "@tanstack/react-query";
import { deleteTask } from "../../api";
import { forgetTask } from "../../live";
import { deleteTaskCopy } from "../../task-view";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Confirms deleting a task and says what goes with it. On success the task
 * leaves the cache at once (the `task.removed` event does the same for every
 * other tab), and an open task view returns to the inbox.
 */
export function DeleteTaskDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const queryClient = useQueryClient();
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
        forgetTask(queryClient, task.id);
      }}
    >
      {before}
      {branch && <span className="mono text-foreground">{branch}</span>}
      {after}
    </ConfirmDialog>
  );
}
