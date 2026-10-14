import type {
  SearchBacklogHit,
  SearchRepoHit,
  SearchResults,
  SearchTaskHit,
} from "@blackwall/shared";
import { isModKey } from "./keyboard";

/** The search palette waits this long after the last key press before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Shorter queries find nothing; the server agrees. */
export const SEARCH_MIN_CHARS = 2;

/** One row of the palette, in display order; `key` is unique across the groups. */
export type SearchEntry =
  | { kind: "task"; key: string; hit: SearchTaskHit }
  | { kind: "backlog"; key: string; hit: SearchBacklogHit }
  | { kind: "repo"; key: string; hit: SearchRepoHit };

/**
 * The palette's rows: tasks, then backlog items, then repos. Repos whose folder is missing are
 * left out once `repos` has loaded, as in the top bar's picker.
 */
export function flattenResults(
  results: SearchResults | undefined,
  repos?: readonly { id: string; exists: boolean }[],
): SearchEntry[] {
  if (!results) return [];
  const usable = repos && new Set(repos.filter((r) => r.exists).map((r) => r.id));
  return [
    ...results.tasks.map((hit): SearchEntry => ({ kind: "task", key: `task:${hit.id}`, hit })),
    ...results.backlogItems.map((hit): SearchEntry => ({
      kind: "backlog",
      key: `backlog:${hit.id}`,
      hit,
    })),
    ...results.repos
      .filter((hit) => !usable || usable.has(hit.id))
      .map((hit): SearchEntry => ({ kind: "repo", key: `repo:${hit.id}`, hit })),
  ];
}

/** The selection after moving `delta` rows from `index`, wrapping at both ends; -1 with no rows. */
export function stepSelection(index: number, delta: number, count: number): number {
  if (count === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (((index + delta) % count) + count) % count;
}

/** `"toggle"` for ⌘K on macOS and Ctrl+K elsewhere (no Shift or Alt); null for other keys. */
export function searchShortcut(event: KeyboardEvent): "toggle" | null {
  return isModKey(event) && !event.shiftKey && event.key.toLowerCase() === "k" ? "toggle" : null;
}

/** Where a row leads; `selectRepo` is the repo to work in once there. */
export type SearchTarget =
  | { to: "/tasks/$taskId"; params: { taskId: string } }
  | {
      to: "/repos/$repoId/backlog";
      params: { repoId: string };
      search: { item?: string };
      selectRepo: string;
    };

/** A task opens its view, a backlog item its repo's Backlog with it in the editor, a repo its Backlog. */
export function resultTarget(entry: SearchEntry): SearchTarget {
  switch (entry.kind) {
    case "task":
      return { to: "/tasks/$taskId", params: { taskId: entry.hit.id } };
    case "backlog":
      return {
        to: "/repos/$repoId/backlog",
        params: { repoId: entry.hit.repoId },
        search: { item: entry.hit.id },
        selectRepo: entry.hit.repoId,
      };
    case "repo":
      return {
        to: "/repos/$repoId/backlog",
        params: { repoId: entry.hit.id },
        search: {},
        selectRepo: entry.hit.id,
      };
  }
}
