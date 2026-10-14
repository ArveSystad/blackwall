import { useSyncExternalStore } from "react";

/**
 * The repo the user is working in, picked from the top bar or by opening its backlog. It frames
 * the main pane: the top bar shows it, New task starts on it and Escape from a task returns to
 * its backlog.
 * Remembered per browser; an id whose repo is gone acts like no selection.
 */
export const SELECTED_REPO_STORAGE_KEY = "blackwall.repo";

const listeners = new Set<() => void>();
let current: string | null | undefined;

/** The stored repo id, or null. Unreadable storage means none. */
export function readSelectedRepo(): string | null {
  try {
    return globalThis.localStorage?.getItem(SELECTED_REPO_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** The selected repo id for this page. */
export function selectedRepoId(): string | null {
  if (current === undefined) current = readSelectedRepo();
  return current;
}

/** Select a repo (or clear with null): remembers it in this browser and notifies listeners. */
export function setSelectedRepo(id: string | null): void {
  if (id === selectedRepoId()) return;
  current = id;
  try {
    if (id === null) globalThis.localStorage?.removeItem(SELECTED_REPO_STORAGE_KEY);
    else globalThis.localStorage?.setItem(SELECTED_REPO_STORAGE_KEY, id);
  } catch {
    // Storage is a convenience; the selection still applies for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The selected repo id, re-rendering when it changes. */
export function useSelectedRepoId(): string | null {
  return useSyncExternalStore(subscribe, selectedRepoId, () => null);
}

/** The selected repo, if it is still registered and its folder exists. */
export function resolveSelectedRepo<R extends { id: string; exists: boolean }>(
  id: string | null,
  repos: readonly R[] | undefined,
): R | undefined {
  if (id === null) return undefined;
  return repos?.find((repo) => repo.id === id && repo.exists);
}
