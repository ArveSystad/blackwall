/**
 * The View Transition type for a top-level route change. Paired with the
 * `:active-view-transition-type(bw-route)` rules in styles.css and the `bw-route` / `bw-inbox`
 * `view-transition-name`s in router.tsx and Inbox.tsx.
 */
export const ROUTE_TRANSITION_TYPE = "bw-route";

/** The top-level view a pathname belongs to: its first segment, or "" for Home. */
export function routeViewKey(pathname: string): string {
  return pathname.split("/").find((segment) => segment !== "") ?? "";
}

/**
 * The View Transition types for a navigation, or `false` to commit it without one. Skips the
 * wipe on first load (`from` undefined), under reduced motion, and whenever both paths share a
 * view: task to task, Settings sections, the Backlog repo, search-param changes and refetches.
 */
export function routeTransitionTypes(
  from: string | undefined,
  to: string,
  reducedMotion: boolean,
): string[] | false {
  if (from === undefined || reducedMotion) return false;
  if (routeViewKey(from) === routeViewKey(to)) return false;
  return [ROUTE_TRANSITION_TYPE];
}

/**
 * Whether the browser can run a typed View Transition. Mirrors router-core's own types check:
 * without it the router would fall back to an untyped root crossfade on every navigation.
 */
export function supportsRouteTransition(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof (document as { startViewTransition?: unknown }).startViewTransition !== "function") {
    return false;
  }
  return globalThis.CSS?.supports?.("selector(:active-view-transition-type(a))") ?? false;
}
