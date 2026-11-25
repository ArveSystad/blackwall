import type { Task } from "@blackwall/shared";

/** The tasks split from `parent`, oldest first (as listed). */
export function childrenOf<T extends Pick<Task, "parentTaskId">>(
  tasks: readonly T[],
  parentId: string,
): T[] {
  return tasks.filter((t) => t.parentTaskId === parentId);
}

/** The task `task` was split from, when it is a subtask and its parent is still listed. */
export function parentOf<T extends Pick<Task, "id">>(
  tasks: readonly T[],
  task: Pick<Task, "parentTaskId">,
): T | undefined {
  return task.parentTaskId === null ? undefined : tasks.find((t) => t.id === task.parentTaskId);
}

export interface SubtaskProgress {
  done: number;
  total: number;
}

/** How many of a parent's subtasks are done; undefined for a task with none. */
export function subtaskProgress(
  tasks: readonly Pick<Task, "parentTaskId" | "status">[],
  parentId: string,
): SubtaskProgress | undefined {
  const children = childrenOf(tasks, parentId);
  if (children.length === 0) return undefined;
  return { done: children.filter((t) => t.status === "done").length, total: children.length };
}

/**
 * Whether the task was split into subtasks: it has proposals and is past plan
 * approval (waiting on them, at its comment-only finish, or done), not still
 * planning or waiting for the plan's approval.
 */
export function isSplitParent(task: Pick<Task, "subtasks" | "gate" | "status">): boolean {
  if (task.subtasks.length === 0) return false;
  return task.status === "waiting" || task.status === "done" || task.gate === "finish";
}

/**
 * A list with each subtask moved right under its parent when the parent is in
 * the list too; other tasks keep their order.
 */
export function nestSubtasks<T extends Pick<Task, "id" | "parentTaskId">>(list: readonly T[]): T[] {
  const ids = new Set(list.map((t) => t.id));
  const nested = (t: T) => t.parentTaskId !== null && ids.has(t.parentTaskId);
  return list.flatMap((t) =>
    nested(t) ? [] : [t, ...list.filter((c) => c.parentTaskId === t.id)],
  );
}

/** Whether a plan has a `### Subtasks` heading (as the server checks before extracting them). */
export function planHasSubtasks(plan: string | null): boolean {
  return plan !== null && /^###\s+Subtasks\s*$/im.test(plan);
}

/**
 * What deleting `task` does to the tasks it is split from or into, for the
 * delete dialog; null when it is neither.
 */
export function deleteSubtasksNote(
  tasks: readonly Pick<Task, "id" | "parentTaskId" | "status">[],
  task: Pick<Task, "id" | "parentTaskId">,
): string | null {
  const children = childrenOf(tasks, task.id);
  if (children.length > 0) {
    return children.length === 1
      ? "Its subtask keeps running as a standalone task."
      : `Its ${children.length} subtasks keep running as standalone tasks.`;
  }
  const parent = parentOf(tasks, task);
  if (parent?.status === "waiting" && childrenOf(tasks, parent.id).length === 1) {
    return "The parent task goes back to plan approval.";
  }
  return null;
}
