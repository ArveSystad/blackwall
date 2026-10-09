import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal in-memory Storage stand-in; the web tests run without a DOM. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("denied");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

async function loadSelectedRepo() {
  // Fresh module per test so the in-memory selection starts unset.
  vi.resetModules();
  return import("./selected-repo");
}

describe("selected repo", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to none with empty storage", async () => {
    const { readSelectedRepo, selectedRepoId } = await loadSelectedRepo();
    expect(readSelectedRepo()).toBeNull();
    expect(selectedRepoId()).toBeNull();
  });

  it("reads a stored selection", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.repo": "r2" }));
    const { selectedRepoId } = await loadSelectedRepo();
    expect(selectedRepoId()).toBe("r2");
  });

  it("remembers a selection and forgets it when cleared", async () => {
    const { setSelectedRepo, selectedRepoId, SELECTED_REPO_STORAGE_KEY } = await loadSelectedRepo();
    setSelectedRepo("r1");
    expect(selectedRepoId()).toBe("r1");
    expect(localStorage.getItem(SELECTED_REPO_STORAGE_KEY)).toBe("r1");
    setSelectedRepo(null);
    expect(selectedRepoId()).toBeNull();
    expect(localStorage.getItem(SELECTED_REPO_STORAGE_KEY)).toBeNull();
  });

  it("still selects for the page when storage throws", async () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { readSelectedRepo, setSelectedRepo, selectedRepoId } = await loadSelectedRepo();
    expect(readSelectedRepo()).toBeNull();
    setSelectedRepo("r1");
    expect(selectedRepoId()).toBe("r1");
    setSelectedRepo(null);
    expect(selectedRepoId()).toBeNull();
  });

  describe("resolveSelectedRepo", () => {
    const repos = [
      { id: "r1", name: "one", exists: true },
      { id: "r2", name: "two", exists: false },
    ];

    it("finds a registered repo whose folder exists", async () => {
      const { resolveSelectedRepo } = await loadSelectedRepo();
      expect(resolveSelectedRepo("r1", repos)).toBe(repos[0]);
    });

    it("ignores no selection, an unknown id, a missing folder or unloaded repos", async () => {
      const { resolveSelectedRepo } = await loadSelectedRepo();
      expect(resolveSelectedRepo(null, repos)).toBeUndefined();
      expect(resolveSelectedRepo("gone", repos)).toBeUndefined();
      expect(resolveSelectedRepo("r2", repos)).toBeUndefined();
      expect(resolveSelectedRepo("r1", undefined)).toBeUndefined();
    });
  });
});
