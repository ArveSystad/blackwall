import type { BacklogItem } from "@blackwall/shared";

/** The fields that decide a backlog item's turn. */
export type BacklogPickItem = Pick<
  BacklogItem,
  "id" | "position" | "createdAt" | "status" | "dependsOn" | "taskId"
>;

/** Whether the task an item was promoted to is done. */
export type IsTaskDone = (taskId: string) => boolean;

/** Pick order: manual position, then age. */
export function sortBacklog<T extends BacklogPickItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/**
 * The dependency ids an item still waits on. A dependency is met once its
 * item is promoted and the linked task is done; a missing item, or a task
 * that failed or was deleted, keeps it unmet.
 */
export function unmetDependencies<T extends BacklogPickItem>(
  item: T,
  byId: ReadonlyMap<string, T>,
  isDone: IsTaskDone,
): string[] {
  return item.dependsOn.filter((depId) => {
    const dep = byId.get(depId);
    return !(dep?.status === "promoted" && dep.taskId !== null && isDone(dep.taskId));
  });
}

/**
 * The next backlog item of one repo to run, or undefined. Mirrors
 * `tasks/pick-next-task.ps1`: only `waiting` items count; items are tried in
 * pick order, and when one is blocked its unmet dependencies are tried (in
 * listed order, depth first) so dependencies run before the items that need
 * them. A missing dependency blocks the item; cycles are cut.
 */
export function nextBacklogItem<T extends BacklogPickItem>(
  items: readonly T[],
  isDone: IsTaskDone,
): T | undefined {
  const byId = new Map(items.map((item) => [item.id, item]));

  const resolve = (item: T, visiting: Set<string>): T | undefined => {
    if (visiting.has(item.id) || item.status !== "waiting") return undefined;
    visiting.add(item.id);
    const unmet = unmetDependencies(item, byId, isDone);
    if (unmet.length === 0) return item;
    for (const depId of unmet) {
      const dep = byId.get(depId);
      if (!dep) return undefined;
      const ready = resolve(dep, visiting);
      if (ready) return ready;
    }
    return undefined;
  };

  for (const item of sortBacklog(items)) {
    const ready = resolve(item, new Set());
    if (ready) return ready;
  }
  return undefined;
}

/** Whether making `itemId` depend on `dependsOn` would close a dependency cycle. */
export function createsDependencyCycle(
  items: readonly Pick<BacklogItem, "id" | "dependsOn">[],
  itemId: string,
  dependsOn: readonly string[],
): boolean {
  const deps = new Map(items.map((item) => [item.id, item.dependsOn]));
  deps.set(itemId, [...dependsOn]);
  const seen = new Set<string>();
  const stack = [...dependsOn];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === itemId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(deps.get(id) ?? []));
  }
  return false;
}
