/**
 * Where the task window was opened from, so leaving it lands there: the Backlog it came from, or
 * the grid. Recorded per history entry by the router (router.tsx), so every way of opening a task
 * counts and Back/Forward keep each entry's own origin. Held in memory only: after a reload a task
 * leaves to the grid.
 */

/** The parts of a router location the origin needs. */
export interface OriginLocation {
  pathname: string;
  state: { __TSR_key?: string; key?: string };
}

/** Where leaving the window goes. */
export type WindowExit = { to: "/" } | { to: "/repos/$repoId/backlog"; params: { repoId: string } };

const BACKLOG_PATH = /^\/repos\/([^/]+)\/backlog$/;
const TASK_PATH = /^\/tasks\/[^/]+$/;

/** The repo id of a Backlog path, or null for any other path. */
export function backlogRepoIdOf(pathname: string): string | null {
  const match = BACKLOG_PATH.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

/** True for a task view path. */
export function isTaskPath(pathname: string): boolean {
  return TASK_PATH.test(pathname);
}

/** Leaving a task goes to the Backlog it was opened from, if any; everything else goes home. */
export function windowExitTarget(pathname: string, originRepoId: string | null): WindowExit {
  return isTaskPath(pathname) && originRepoId !== null
    ? { to: "/repos/$repoId/backlog", params: { repoId: originRepoId } }
    : { to: "/" };
}

/** History entry key → the Backlog repo the task in that entry was opened from, or null. */
const origins = new Map<string, string | null>();

function entryKey(location: OriginLocation): string | undefined {
  return location.state.__TSR_key ?? location.state.key;
}

/**
 * Records where a task entry was opened from, the first time it resolves. Later resolves of the
 * same entry (Back/Forward) keep the original origin.
 */
export function recordWindowOrigin(
  fromPathname: string | undefined,
  toLocation: OriginLocation,
): void {
  if (!isTaskPath(toLocation.pathname)) return;
  const key = entryKey(toLocation);
  if (key === undefined || origins.has(key)) return;
  origins.set(key, fromPathname === undefined ? null : backlogRepoIdOf(fromPathname));
}

/** The Backlog repo the entry with `key` was opened from, or null when unknown. */
export function windowOriginFor(key: string | undefined): string | null {
  return key === undefined ? null : (origins.get(key) ?? null);
}

/** The origin of the entry at `location`. */
export function windowOriginOf(location: OriginLocation): string | null {
  return windowOriginFor(entryKey(location));
}
