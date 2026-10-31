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

/**
 * Stub `matchMedia` for the light color-scheme query. `setPrefersLight` changes the device
 * preference; `fire` delivers a `change` event to the registered listeners.
 */
function stubMatchMedia(prefersLight: boolean) {
  let light = prefersLight;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(prefers-color-scheme: light)" && light;
    },
    media: query,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "change") listeners.delete(listener);
    },
  }));
  return {
    setPrefersLight: (value: boolean) => void (light = value),
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

async function loadTheme() {
  // Fresh module per test so the in-memory current theme and lock start unset.
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

  describe("reading", () => {
    it("defaults to dark with empty storage and no matchMedia", async () => {
      const { readTheme, currentTheme } = await loadTheme();
      expect(readTheme()).toBe("dark");
      expect(currentTheme()).toBe("dark");
    });

    it("follows the OS preference with empty storage", async () => {
      stubMatchMedia(true);
      let theme = await loadTheme();
      expect(theme.readTheme()).toBe("light");
      expect(theme.currentTheme()).toBe("light");

      stubMatchMedia(false);
      theme = await loadTheme();
      expect(theme.readTheme()).toBe("dark");
      expect(theme.currentTheme()).toBe("dark");
    });

    it("prefers a stored theme over the OS preference", async () => {
      stubMatchMedia(true);
      vi.stubGlobal("localStorage", memoryStorage({ "blackwall.theme": "dark" }));
      const { currentTheme } = await loadTheme();
      expect(currentTheme()).toBe("dark");
    });

    it("reads a stored light choice", async () => {
      vi.stubGlobal("localStorage", memoryStorage({ "blackwall.theme": "light" }));
      const { currentTheme } = await loadTheme();
      expect(currentTheme()).toBe("light");
    });

    it("treats an unknown stored value as the OS theme", async () => {
      stubMatchMedia(true);
      vi.stubGlobal("localStorage", memoryStorage({ "blackwall.theme": "solarized" }));
      const { readTheme } = await loadTheme();
      expect(readTheme()).toBe("light");
    });

    it("falls back to the OS theme when storage throws, and still toggles for the page", async () => {
      stubMatchMedia(true);
      vi.stubGlobal("localStorage", throwingStorage);
      const { readTheme, isThemeLocked, toggleTheme, toggleThemeLock } = await loadTheme();
      expect(readTheme()).toBe("light");
      expect(isThemeLocked()).toBe(false);
      expect(toggleTheme()).toBe("dark");
      expect(toggleTheme()).toBe("light");
      expect(toggleThemeLock()).toBe(true);
      expect(toggleThemeLock()).toBe(false);
    });
  });

  describe("unlocked", () => {
    it("stores a theme that differs from the OS and forgets one that matches", async () => {
      stubMatchMedia(false);
      const { readTheme, toggleTheme, THEME_STORAGE_KEY } = await loadTheme();
      expect(toggleTheme()).toBe("light");
      expect(readTheme()).toBe("light");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
      expect(toggleTheme()).toBe("dark");
      expect(readTheme()).toBe("dark");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    });

    it("follows a live OS switch, dropping a stored choice", async () => {
      const media = stubMatchMedia(false);
      const meta = { setAttribute: vi.fn() };
      vi.stubGlobal("document", stubDocument(meta));
      const { currentTheme, toggleTheme, watchSystemTheme, THEME_STORAGE_KEY } = await loadTheme();
      watchSystemTheme();
      toggleTheme();
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

      media.setPrefersLight(true);
      media.fire();
      expect(currentTheme()).toBe("light");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

      media.setPrefersLight(false);
      media.fire();
      expect(currentTheme()).toBe("dark");
      expect(meta.setAttribute).toHaveBeenLastCalledWith("content", "#0a0918");
    });

    it("stops following once unwatched", async () => {
      const media = stubMatchMedia(false);
      const { currentTheme, watchSystemTheme } = await loadTheme();
      expect(currentTheme()).toBe("dark");
      const unwatch = watchSystemTheme();
      unwatch();
      media.setPrefersLight(true);
      media.fire();
      expect(currentTheme()).toBe("dark");
    });

    it("watches nothing without matchMedia or change events", async () => {
      let theme = await loadTheme();
      expect(() => theme.watchSystemTheme()()).not.toThrow();

      vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
      theme = await loadTheme();
      expect(() => theme.watchSystemTheme()()).not.toThrow();
    });
  });

  describe("locking", () => {
    it("locks the current theme, storing it even when it matches the OS", async () => {
      stubMatchMedia(false);
      const { isThemeLocked, toggleThemeLock, THEME_STORAGE_KEY, THEME_LOCK_STORAGE_KEY } =
        await loadTheme();
      expect(toggleThemeLock()).toBe(true);
      expect(isThemeLocked()).toBe(true);
      expect(localStorage.getItem(THEME_LOCK_STORAGE_KEY)).toBe("1");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    });

    it("ignores OS switches while locked", async () => {
      const media = stubMatchMedia(false);
      const { currentTheme, toggleThemeLock, watchSystemTheme, THEME_STORAGE_KEY } =
        await loadTheme();
      watchSystemTheme();
      toggleThemeLock();
      media.setPrefersLight(true);
      media.fire();
      expect(currentTheme()).toBe("dark");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    });

    it("toggles and stores the theme while staying locked", async () => {
      stubMatchMedia(false);
      const { isThemeLocked, toggleTheme, toggleThemeLock, THEME_STORAGE_KEY } = await loadTheme();
      toggleThemeLock();
      expect(toggleTheme()).toBe("light");
      expect(toggleTheme()).toBe("dark");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
      expect(isThemeLocked()).toBe(true);
    });

    it("reads a stored lock", async () => {
      vi.stubGlobal("localStorage", memoryStorage({ "blackwall.themeLocked": "1" }));
      const { isThemeLocked } = await loadTheme();
      expect(isThemeLocked()).toBe(true);
    });

    it("unlocks and follows the OS straight away", async () => {
      stubMatchMedia(true);
      const {
        currentTheme,
        isThemeLocked,
        toggleTheme,
        toggleThemeLock,
        THEME_STORAGE_KEY,
        THEME_LOCK_STORAGE_KEY,
      } = await loadTheme();
      toggleThemeLock();
      toggleTheme();
      expect(currentTheme()).toBe("dark");
      expect(toggleThemeLock()).toBe(false);
      expect(isThemeLocked()).toBe(false);
      expect(currentTheme()).toBe("light");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(THEME_LOCK_STORAGE_KEY)).toBeNull();
    });
  });

  it("notifies subscribers on lock, unlock and OS switches until unsubscribed", async () => {
    const media = stubMatchMedia(false);
    const { subscribeTheme, toggleThemeLock, watchSystemTheme } = await loadTheme();
    watchSystemTheme();
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);
    toggleThemeLock();
    expect(listener).toHaveBeenCalledTimes(1);
    toggleThemeLock();
    expect(listener).toHaveBeenCalledTimes(2);
    media.setPrefersLight(true);
    media.fire();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    toggleThemeLock();
    media.fire();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("publishes the canvas colour as theme-color", async () => {
    const meta = { setAttribute: vi.fn() };
    vi.stubGlobal("document", stubDocument(meta));
    const { setTheme } = await loadTheme();
    setTheme("light");
    expect(meta.setAttribute).toHaveBeenLastCalledWith("content", "#f3f3f6");
    setTheme("dark");
    expect(meta.setAttribute).toHaveBeenLastCalledWith("content", "#0a0918");
  });

  it("switches theme without a theme-color tag", async () => {
    vi.stubGlobal("document", stubDocument(null));
    const { setTheme, currentTheme } = await loadTheme();
    expect(() => setTheme("light")).not.toThrow();
    expect(currentTheme()).toBe("light");
  });
});

/** Just enough of `document` for `applyTheme`: <html> attributes and the theme-color tag. */
function stubDocument(meta: { setAttribute: (name: string, value: string) => void } | null) {
  return {
    documentElement: { setAttribute: vi.fn(), removeAttribute: vi.fn() },
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? meta : null),
  };
}
