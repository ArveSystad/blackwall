import { isSettingsSection, type SettingsSection } from "./settings-sections";

/** The shutter's slide: 200ms, paired with `.bw-shutter` in styles.css. Change them together. */
export const SHUTTER_MS = 200;
/** Settles the slide when no `transitionend` comes (background tab, old engine). */
export const SHUTTER_FALLBACK_MS = SHUTTER_MS + 50;

/**
 * Where the Settings shutter is in its slide. It stays mounted while `opening` and `closing`, so
 * reopening mid-close reverses the slide.
 */
export type ShutterPresence = "closed" | "opening" | "open" | "closing";

export interface ShutterState {
  presence: ShutterPresence;
  /** The section shown; kept while closing so the panel doesn't change as it slides up. */
  section: SettingsSection;
}

/** True for `/settings` and anything under it, valid section or not. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * The section a path shows: `/settings` is Connections (its redirect), `/settings/<section>` that
 * section. Null elsewhere and for an unknown section, which the route shows as not found.
 */
export function settingsSectionOf(pathname: string): SettingsSection | null {
  const path = pathname.replace(/\/+$/, "");
  if (path === "/settings") return "connections";
  const id = /^\/settings\/([^/]+)$/.exec(path)?.[1];
  return id !== undefined && isSettingsSection(id) ? id : null;
}

/** First load: a Settings URL shows the panel without sliding. */
export function initialShutterPresence(pathname: string): ShutterPresence {
  return settingsSectionOf(pathname) ? "open" : "closed";
}

/** The presence when Settings opens; reduced motion skips the slide. */
export function openShutterPresence(presence: ShutterPresence, reduced: boolean): ShutterPresence {
  if (presence === "open" || presence === "opening") return presence;
  return reduced ? "open" : "opening";
}

/** The presence when Settings is left; reduced motion skips the slide. */
export function closeShutterPresence(presence: ShutterPresence, reduced: boolean): ShutterPresence {
  if (presence === "closed" || presence === "closing") return presence;
  return reduced ? "closed" : "closing";
}

/** The presence once the slide ends. Idempotent, so `transitionend` and the fallback can both call it. */
export function settleShutterPresence(presence: ShutterPresence): ShutterPresence {
  if (presence === "opening") return "open";
  if (presence === "closing") return "closed";
  return presence;
}

/**
 * The state after the URL's path changes. A Settings path shows its section, opening without a
 * slide from `closed` (the blocker already started the slide for animated opens) and reversing a
 * close; any other path slides the panel up over the page already mounted beneath. Returns `state`
 * itself when nothing changes.
 */
export function nextShutterOnPath(
  state: ShutterState,
  pathname: string,
  reduced: boolean,
): ShutterState {
  const section = settingsSectionOf(pathname);
  let presence = state.presence;
  if (section) {
    if (presence === "closed") presence = "open";
    else if (presence === "closing") presence = openShutterPresence(presence, reduced);
  } else {
    presence = closeShutterPresence(presence, reduced);
  }
  const nextSection = section ?? state.section;
  if (presence === state.presence && nextSection === state.section) return state;
  return { presence, section: nextSection };
}

/** Whether a navigation enters Settings from elsewhere, so the panel slides down before it commits. */
export function shouldAnimateOpen(currentPath: string, nextPath: string): boolean {
  return settingsSectionOf(nextPath) !== null && !isSettingsPath(currentPath);
}
