import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal in-memory Storage stand-in; the web tests run without a DOM. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

const deny = () => {
  throw new Error("denied");
};

const throwingStorage = {
  getItem: deny,
  setItem: deny,
  removeItem: deny,
  key: deny,
  get length(): number {
    return deny();
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const text = (raw: unknown) => (typeof raw === "string" ? raw : undefined);

async function loadDrafts() {
  // Fresh module per test so the in-memory drafts start empty and storage is read again.
  vi.resetModules();
  return import("./drafts");
}

describe("drafts", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("round-trips a draft through storage", async () => {
    const { writeDraft, flushDrafts, DRAFT_STORAGE_PREFIX } = await loadDrafts();
    writeDraft("task:t1:chat", "half a thought");
    flushDrafts();
    const stored = JSON.parse(localStorage.getItem(`${DRAFT_STORAGE_PREFIX}task:t1:chat`)!);
    expect(stored.value).toBe("half a thought");
    expect(typeof stored.at).toBe("number");

    const { readDraft } = await loadDrafts();
    expect(readDraft("task:t1:chat", text)).toBe("half a thought");
  });

  it("writes to storage after a short delay but reads at once", async () => {
    vi.useFakeTimers();
    const { writeDraft, readDraft } = await loadDrafts();
    writeDraft("task:t1:chat", "typing");
    expect(readDraft("task:t1:chat", text)).toBe("typing");
    vi.advanceTimersByTime(299);
    expect(localStorage.getItem("blackwall.drafts.task:t1:chat")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(localStorage.getItem("blackwall.drafts.task:t1:chat")).not.toBeNull();
  });

  it("removes a sent draft at once, including a pending write", async () => {
    vi.useFakeTimers();
    const { writeDraft, flushDrafts, removeDraft, readDraft } = await loadDrafts();
    writeDraft("task:t1:chat", "first");
    flushDrafts();
    writeDraft("task:t1:chat", "second");
    removeDraft("task:t1:chat");
    expect(localStorage.getItem("blackwall.drafts.task:t1:chat")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(localStorage.getItem("blackwall.drafts.task:t1:chat")).toBeNull();
    expect(readDraft("task:t1:chat", text)).toBeUndefined();
  });

  it("drops stale and unreadable drafts on load, keeping recent ones and other keys", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    const now = Date.now();
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        "blackwall.drafts.old": JSON.stringify({ value: "old", at: now - 15 * DAY_MS }),
        "blackwall.drafts.recent": JSON.stringify({ value: "recent", at: now - 13 * DAY_MS }),
        "blackwall.drafts.broken": "{not json",
        "blackwall.drafts.shapeless": JSON.stringify({ value: "no time" }),
        "blackwall.theme": "light",
      }),
    );
    const { readDraft } = await loadDrafts();
    expect(readDraft("recent", text)).toBe("recent");
    expect(readDraft("old", text)).toBeUndefined();
    expect(localStorage.getItem("blackwall.drafts.old")).toBeNull();
    expect(localStorage.getItem("blackwall.drafts.broken")).toBeNull();
    expect(localStorage.getItem("blackwall.drafts.shapeless")).toBeNull();
    expect(localStorage.getItem("blackwall.drafts.recent")).not.toBeNull();
    expect(localStorage.getItem("blackwall.theme")).toBe("light");
  });

  it("reads a draft of the wrong shape as none", async () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({
        "blackwall.drafts.task:t1:chat": JSON.stringify({ value: 42, at: Date.now() }),
      }),
    );
    const { readDraft } = await loadDrafts();
    expect(readDraft("task:t1:chat", text)).toBeUndefined();
  });

  it("clears every draft of a deleted task and nothing else", async () => {
    const { writeDraft, flushDrafts, clearTaskDrafts, readDraft } = await loadDrafts();
    for (const key of [
      "task:t1:chat",
      "task:t1:grill:q1",
      "task:t1:diff",
      "task:t10:chat",
      "repo:r1:chat",
    ]) {
      writeDraft(key, key);
    }
    flushDrafts();
    clearTaskDrafts("t1");
    expect(localStorage.getItem("blackwall.drafts.task:t1:chat")).toBeNull();
    expect(localStorage.getItem("blackwall.drafts.task:t1:grill:q1")).toBeNull();
    expect(localStorage.getItem("blackwall.drafts.task:t1:diff")).toBeNull();
    expect(readDraft("task:t1:chat", text)).toBeUndefined();
    expect(readDraft("task:t10:chat", text)).toBe("task:t10:chat");
    expect(readDraft("repo:r1:chat", text)).toBe("repo:r1:chat");
    expect(localStorage.getItem("blackwall.drafts.task:t10:chat")).not.toBeNull();
    expect(localStorage.getItem("blackwall.drafts.repo:r1:chat")).not.toBeNull();
  });

  it("keeps drafts for the page when storage throws", async () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { writeDraft, readDraft, removeDraft, flushDrafts, clearTaskDrafts } = await loadDrafts();
    expect(() => writeDraft("task:t1:chat", "kept")).not.toThrow();
    expect(() => flushDrafts()).not.toThrow();
    expect(readDraft("task:t1:chat", text)).toBe("kept");
    expect(() => removeDraft("task:t1:chat")).not.toThrow();
    expect(readDraft("task:t1:chat", text)).toBeUndefined();
    expect(() => clearTaskDrafts("t1")).not.toThrow();
  });

  it("stamps equal text alike and different text apart", async () => {
    const { draftStamp } = await loadDrafts();
    expect(draftStamp("the plan")).toBe(draftStamp("the plan"));
    expect(draftStamp("the plan")).not.toBe(draftStamp("the plan, revised"));
    expect(draftStamp("")).toMatch(/^[0-9a-z]+$/);
  });
});
