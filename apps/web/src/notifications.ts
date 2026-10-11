import type { Task } from "@blackwall/shared";
import { useSyncExternalStore } from "react";
import { needsYouCount } from "./inbox";

/**
 * Desktop notifications are opt-in per browser, since the permission belongs to the browser.
 * Off unless storage holds exactly `on`.
 */
export const NOTIFICATIONS_STORAGE_KEY = "blackwall.notifications";

const listeners = new Set<() => void>();
let current: boolean | undefined;

/** The stored choice: off unless storage holds exactly `on`. Unreadable storage means off. */
export function readNotificationsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(NOTIFICATIONS_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Whether notifications are turned on for this page. */
export function notificationsEnabled(): boolean {
  current ??= readNotificationsEnabled();
  return current;
}

/** Turn notifications on or off: remembers it in this browser and notifies the hook. */
export function setNotificationsEnabled(on: boolean): void {
  current = on;
  try {
    globalThis.localStorage?.setItem(NOTIFICATIONS_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage is a convenience; the choice still applies for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether notifications are on, re-rendering when that changes. */
export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, notificationsEnabled, () => false);
}

export type NotificationPermissionState = NotificationPermission | "unsupported";

/** The browser's notification permission, or `unsupported` without the Notification API. */
export function notificationPermission(): NotificationPermissionState {
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

/** Notify only when the user opted in and the browser granted permission. */
export function canNotify(enabled: boolean, permission: NotificationPermissionState): boolean {
  return enabled && permission === "granted";
}

/** Ids of the tasks that need the user; the caller keeps them as the next `previousIds`. */
export function needsYouIds(tasks: readonly Task[]): string[] {
  return tasks.filter((t) => t.status === "needs-you").map((t) => t.id);
}

/**
 * The task to notify about when the needs-you count rises: the most recently updated needs-you
 * task not in `previousIds`. Null on first load (`previousIds` null), when the count holds or
 * falls, or when no new task needs the user.
 */
export function needsYouToNotify(
  previousIds: readonly string[] | null,
  tasks: readonly Task[],
): Task | null {
  if (previousIds === null) return null;
  if (needsYouCount(tasks) <= previousIds.length) return null;
  const previous = new Set(previousIds);
  const fresh = tasks
    .filter((t) => t.status === "needs-you" && !previous.has(t.id))
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return fresh[0] ?? null;
}
