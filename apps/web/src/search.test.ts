import type { SearchResults } from "@blackwall/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flattenResults, resultTarget, searchShortcut, stepSelection } from "./search";

const results: SearchResults = {
  tasks: [
    {
      id: "t1",
      title: "Fix login",
      repoId: "r1",
      repoName: "app",
      status: "done",
      archived: true,
      origin: { kind: "free-text" },
      snippet: null,
    },
  ],
  backlogItems: [
    {
      id: "b1",
      title: "Login tests",
      repoId: "r2",
      repoName: "api",
      status: "waiting",
      origin: { kind: "free-text" },
      snippet: "cover the login form",
    },
  ],
  repos: [
    { id: "r1", name: "login-app", path: "/code/login-app" },
    { id: "r3", name: "login-old", path: "/code/login-old" },
  ],
};

describe("stepSelection", () => {
  it("wraps down and up", () => {
    expect(stepSelection(0, 1, 3)).toBe(1);
    expect(stepSelection(2, 1, 3)).toBe(0);
    expect(stepSelection(0, -1, 3)).toBe(2);
  });

  it("starts at an end without a selection, and is -1 without rows", () => {
    expect(stepSelection(-1, 1, 3)).toBe(0);
    expect(stepSelection(-1, -1, 3)).toBe(2);
    expect(stepSelection(0, 1, 0)).toBe(-1);
  });
});

describe("flattenResults", () => {
  it("lists tasks, then backlog items, then repos", () => {
    expect(flattenResults(results).map((e) => e.key)).toEqual([
      "task:t1",
      "backlog:b1",
      "repo:r1",
      "repo:r3",
    ]);
  });

  it("drops repos whose folder is missing", () => {
    const repos = [
      { id: "r1", exists: true },
      { id: "r3", exists: false },
    ];
    expect(flattenResults(results, repos).map((e) => e.key)).toEqual([
      "task:t1",
      "backlog:b1",
      "repo:r1",
    ]);
  });

  it("is empty without results", () => {
    expect(flattenResults(undefined)).toEqual([]);
  });
});

describe("searchShortcut", () => {
  afterEach(() => vi.unstubAllGlobals());

  function key(overrides: Partial<KeyboardEvent> = {}) {
    return {
      key: "k",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    } as KeyboardEvent;
  }

  it("toggles on Ctrl+K off macOS", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(searchShortcut(key({ ctrlKey: true }))).toBe("toggle");
    expect(searchShortcut(key({ ctrlKey: true, key: "K" }))).toBe("toggle");
    expect(searchShortcut(key({ metaKey: true }))).toBeNull();
  });

  it("toggles on ⌘K on macOS", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    expect(searchShortcut(key({ metaKey: true }))).toBe("toggle");
    expect(searchShortcut(key({ ctrlKey: true }))).toBeNull();
  });

  it("ignores a plain k, Alt and Shift", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(searchShortcut(key())).toBeNull();
    expect(searchShortcut(key({ ctrlKey: true, altKey: true }))).toBeNull();
    expect(searchShortcut(key({ ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(searchShortcut(key({ ctrlKey: true, key: "j" }))).toBeNull();
  });
});

describe("resultTarget", () => {
  const [task, item, repo] = flattenResults(results);

  it("opens a task's view", () => {
    expect(resultTarget(task!)).toEqual({ to: "/tasks/$taskId", params: { taskId: "t1" } });
  });

  it("opens a backlog item in its repo's Backlog", () => {
    expect(resultTarget(item!)).toEqual({
      to: "/repos/$repoId/backlog",
      params: { repoId: "r2" },
      search: { item: "b1" },
      selectRepo: "r2",
    });
  });

  it("opens a repo's Backlog", () => {
    expect(resultTarget(repo!)).toEqual({
      to: "/repos/$repoId/backlog",
      params: { repoId: "r1" },
      search: {},
      selectRepo: "r1",
    });
  });
});
