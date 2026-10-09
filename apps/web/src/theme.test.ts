import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

async function loadTheme() {
  // Fresh module per test so the in-memory current theme starts unset.
  vi.resetModules();
  return import("./theme");
}

describe("theme", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to dark with empty storage", async () => {
    const { readTheme, currentTheme } = await loadTheme();
    expect(readTheme()).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("stays dark even when the OS prefers light", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-color-scheme: light)",
      media: query,
    }));
    const { readTheme, currentTheme } = await loadTheme();
    expect(readTheme()).toBe("dark");
    expect(currentTheme()).toBe("dark");
  });

  it("toggles dark → light → dark and remembers each choice", async () => {
    const { readTheme, toggleTheme, THEME_STORAGE_KEY } = await loadTheme();
    expect(toggleTheme()).toBe("light");
    expect(readTheme()).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(readTheme()).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("reads a stored light choice", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.theme": "light" }));
    const { currentTheme } = await loadTheme();
    expect(currentTheme()).toBe("light");
  });

  it("treats an unknown stored value as dark", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "blackwall.theme": "solarized" }));
    const { readTheme } = await loadTheme();
    expect(readTheme()).toBe("dark");
  });

  it("falls back to dark when storage throws, and still toggles for the page", async () => {
    vi.stubGlobal("localStorage", throwingStorage);
    const { readTheme, toggleTheme } = await loadTheme();
    expect(readTheme()).toBe("dark");
    expect(toggleTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
  });
});
