/**
 * Where the task window was opened from, so leaving it lands there: the Backlog or list it came
 * from, or the grid. Recorded per history entry by the router (router.tsx), so every way of opening a task
 * counts and Back/Forward keep each entry's own origin. Held in memory only: after a reload a task
 * leaves to the grid.
 */

/** The parts of a router location the origin needs. */
export interface OriginLocation {
  pathname: string;
  state: { __TSR_key?: string; key?: string };
}

/** Where leaving the window goes. */
export type WindowExit =
  | { to: "/" }
  | { to: "/repos/$repoId/backlog"; params: { repoId: string } }
  | { to: "/reviews" }
  | { to: "/issues" }
  | { to: "/pulls" }
  | { to: "/active" };

/** The list windows a task can be opened from. */
const LIST_PATHS = ["/reviews", "/issues", "/pulls", "/active"] as const;

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

/** The window exit back to the Backlog or list at `pathname`, or null for any other path. */
export function windowOriginOfPath(pathname: string): WindowExit | null {
  const repoId = backlogRepoIdOf(pathname);
  if (repoId !== null) return { to: "/repos/$repoId/backlog", params: { repoId } };
  const list = LIST_PATHS.find((path) => path === pathname);
  return list === undefined ? null : { to: list };
}

/**
 * Leaving a task goes to the Backlog or list it was opened from, if any; everything else goes
 * home.
 */
export function windowExitTarget(pathname: string, origin: WindowExit | null): WindowExit {
  return isTaskPath(pathname) && origin !== null ? origin : { to: "/" };
}

/** History entry key → where the task in that entry was opened from, or null. */
const origins = new Map<string, WindowExit | null>();

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
  origins.set(key, fromPathname === undefined ? null : windowOriginOfPath(fromPathname));
}

/** Where the entry with `key` was opened from, or null when unknown. */
export function windowOriginFor(key: string | undefined): WindowExit | null {
  return key === undefined ? null : (origins.get(key) ?? null);
}

/** The origin of the entry at `location`. */
export function windowOriginOf(location: OriginLocation): WindowExit | null {
  return windowOriginFor(entryKey(location));
}
