import type { Repo } from "@blackwall/shared";

type Ordered = Pick<Repo, "id" | "favorite">;

/**
 * Every repo's id in order after dropping `id` where `targetId` is, inside
 * one group (favourites or the rest). Null across groups or onto itself.
 */
export function reorderRepoIds(
  repos: readonly Ordered[],
  id: string,
  targetId: string,
): string[] | null {
  const repo = repos.find((r) => r.id === id);
  const target = repos.find((r) => r.id === targetId);
  if (!repo || !target || repo === target || repo.favorite !== target.favorite) return null;
  const ids = repos.map((r) => r.id);
  const from = ids.indexOf(id);
  const to = ids.indexOf(targetId);
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return ids;
}

/**
 * Every repo's id in order after moving `id` one step (`delta` -1 up, +1 down)
 * inside its group, or null when it cannot move further.
 */
export function moveRepo(repos: readonly Ordered[], id: string, delta: -1 | 1): string[] | null {
  const repo = repos.find((r) => r.id === id);
  if (!repo) return null;
  const group = repos.filter((r) => r.favorite === repo.favorite);
  const to = group.indexOf(repo) + delta;
  if (to < 0 || to >= group.length) return null;
  return reorderRepoIds(repos, id, group[to]!.id);
}
