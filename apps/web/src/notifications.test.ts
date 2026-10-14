import type { TaskCi } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canNotify,
  needsYouIds,
  needsYouToNotify,
  type NotificationPermissionState,
} from "./notifications";
import { makeTask } from "./test-fixtures";

/** CI on a pushed commit whose one check run failed. */
const failedCi: TaskCi = {
  state: "failed",
  sha: "abc1234def5678",
  host: "github.com",
  owner: "acme",
  repo: "web",
  checks: [
    {
      name: "unit",
      kind: "check-run",
      id: 7,
      state: "failed",
      conclusion: "failure",
      url: "https://github.com/acme/web/runs/7",
    },
  ],
  hint: null,
  startedAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:05:00.000Z",
  finishedAt: "2026-10-08T10:05:00.000Z",
};

/** Minimal in-memory Storage stand-in; the web tests run without a DOM. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
};

async function loadNotifications() {
  // Fresh module per test so the in-memory current choice starts unset.
  vi.resetModules();
  return import("./notifications");
}

describe("needsYouToNotify", () => {
  const waiting = makeTask({ status: "needs-you", gate: "finish" });
  const running = makeTask({ status: "running" });

  it("stays quiet on first load", () => {
    expect(needsYouToNotify(null, [waiting])).toBeNull();
  });

  it("stays quiet when the count is unchanged", () => {
    expect(needsYouToNotify([waiting.id], [waiting, running])).toBeNull();
  });

  it("stays quiet when the count falls", () => {
    expect(needsYouToNotify([waiting.id, "gone"], [waiting, running])).toBeNull();
  });

  it("returns the new task when the count rises by one", () => {
    const fresh = makeTask({ status: "needs-you", gate: "plan-approval" });
    expect(needsYouToNotify([waiting.id], [waiting, running, fresh])).toBe(fresh);
  });

  it("returns the most recently updated new task when the count rises by two", () => {
    const older = makeTask({ status: "needs-you", updatedAt: new Date("2026-10-08T11:00:00Z") });
    const newer = makeTask({ status: "needs-you", updatedAt: new Date("2026-10-08T12:00:00Z") });
    expect(needsYouToNotify([waiting.id], [older, waiting, newer])).toBe(newer);
  });

  it("stays quiet when one task resolves as another arrives", () => {
    const fresh = makeTask({ status: "needs-you" });
    expect(needsYouToNotify([waiting.id], [fresh, { ...waiting, status: "running" }])).toBeNull();
  });

  it("returns a done task whose CI newly failed", () => {
    const ciFailed = makeTask({ status: "done", ci: failedCi });
    expect(needsYouToNotify([waiting.id], [waiting, running, ciFailed])).toBe(ciFailed);
  });

  it("stays quiet about a CI failure already in previousIds", () => {
    const ciFailed = makeTask({ status: "done", ci: failedCi });
    expect(needsYouToNotify([waiting.id, ciFailed.id], [waiting, running, ciFailed])).toBeNull();
  });
});

describe("needsYouIds", () => {
  it("lists only needs-you tasks", () => {
    const a = makeTask({ status: "needs-you" });
    const b = makeTask({ status: "done" });
    const c = makeTask({ status: "needs-you" });
    expect(needsYouIds([a, b, c])).toEqual([a.id, c.id]);
  });

  it("includes done tasks whose CI failed", () => {
    const a = makeTask({ status: "needs-you" });
    const ciFailed = makeTask({ status: "done", ci: failedCi });
    const passed = makeTask({ status: "done" });
    expect(needsYouIds([a, ciFailed, passed])).toEqual([a.id, ciFailed.id]);
  });
});

describe("canNotify", () => {
  const permissions: [NotificationPermissionState, boolean][] = [
    ["granted", true],
    ["default", false],
    ["denied", false],
    ["unsupported", false],
  ];

  it.each(permissions)("enabled with %s permission → %s", (permission, expected) => {
    expect(canNotify(true, permission)).toBe(expected);
  });

  it.each(permissions)("disabled with %s permission → false", (permission) => {
    expect(canNotify(false, permission)).toBe(false);
  });
});

describe("notifications setting", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to off with empty storage", async () => {
    const { readNotificationsEnabled, notificationsEnabled } = await loadNotifications();
    expect(readNotificationsEnabled()).toBe(false);
    expect(notificationsEnabled()).toBe(false);
  });

  it("remembers turning on and off", async () => {
    const { readNotificationsEnabled, setNotificationsEnabled, NOTIFICATIONS_STORAGE_KEY } =
      await loadNotifications();
    setNotificationsEnabled(true);
    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("on");
    expect(readNotificationsEnabled()).toBe(true);
    setNotificationsEnabled(false);
    expect(readNotificationsEnabled()).toBe(false);
  });

  it("reads a stored on choice and treats anything else as off", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.notifications": "on" }));
    expect((await loadNotifications()).notificationsEnabled()).toBe(true);
    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.notifications": "yes" }));
    expect((await loadNotifications()).notificationsEnabled()).toBe(false);
  });

  it("falls back to off when storage throws, and still applies for the page", async () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { readNotificationsEnabled, notificationsEnabled, setNotificationsEnabled } =
      await loadNotifications();
    expect(readNotificationsEnabled()).toBe(false);
    setNotificationsEnabled(true);
    expect(notificationsEnabled()).toBe(true);
  });

  it("reports unsupported without the Notification API", async () => {
    vi.stubGlobal("Notification", undefined);
    const { notificationPermission } = await loadNotifications();
    expect(notificationPermission()).toBe("unsupported");
  });
});
