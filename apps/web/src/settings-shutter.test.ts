import { describe, expect, it } from "vitest";
import {
  SHUTTER_FALLBACK_MS,
  SHUTTER_MS,
  closeShutterPresence,
  initialShutterPresence,
  isSettingsPath,
  nextShutterOnPath,
  openShutterPresence,
  settingsSectionOf,
  settleShutterPresence,
  shouldAnimateOpen,
  type ShutterPresence,
  type ShutterState,
} from "./settings-shutter";

describe("settings shutter paths", () => {
  it("reads the section from the path, as the routes do", () => {
    expect(settingsSectionOf("/settings")).toBe("connections");
    expect(settingsSectionOf("/settings/voice")).toBe("voice");
    expect(settingsSectionOf("/settings/bogus")).toBeNull();
    expect(settingsSectionOf("/settingsx")).toBeNull();
    expect(settingsSectionOf("/")).toBeNull();
  });

  it("knows Settings paths, valid section or not", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/bogus")).toBe(true);
    expect(isSettingsPath("/settingsx")).toBe(false);
    expect(isSettingsPath("/stats")).toBe(false);
  });

  it("animates only opens from outside Settings into a real section", () => {
    expect(shouldAnimateOpen("/", "/settings/tags")).toBe(true);
    expect(shouldAnimateOpen("/settings", "/settings/connections")).toBe(false);
    expect(shouldAnimateOpen("/settings/tags", "/settings/voice")).toBe(false);
    expect(shouldAnimateOpen("/", "/settings/bogus")).toBe(false);
    expect(shouldAnimateOpen("/settings/tags", "/")).toBe(false);
  });
});

describe("settings shutter presence", () => {
  const all: ShutterPresence[] = ["closed", "opening", "open", "closing"];

  it("shows a Settings URL on first load without sliding", () => {
    expect(initialShutterPresence("/settings/tags")).toBe("open");
    expect(initialShutterPresence("/settings")).toBe("open");
    expect(initialShutterPresence("/")).toBe("closed");
    expect(initialShutterPresence("/settings/bogus")).toBe("closed");
  });

  it("opens with a slide, or at once under reduced motion", () => {
    expect(openShutterPresence("closed", false)).toBe("opening");
    expect(openShutterPresence("closing", false)).toBe("opening");
    expect(openShutterPresence("closed", true)).toBe("open");
    expect(openShutterPresence("closing", true)).toBe("open");
    expect(openShutterPresence("open", false)).toBe("open");
    expect(openShutterPresence("opening", true)).toBe("opening");
  });

  it("closes with a slide, or at once under reduced motion", () => {
    expect(closeShutterPresence("open", false)).toBe("closing");
    expect(closeShutterPresence("opening", false)).toBe("closing");
    expect(closeShutterPresence("open", true)).toBe("closed");
    expect(closeShutterPresence("opening", true)).toBe("closed");
    expect(closeShutterPresence("closed", false)).toBe("closed");
    expect(closeShutterPresence("closing", true)).toBe("closing");
  });

  it("settles idempotently", () => {
    expect(settleShutterPresence("opening")).toBe("open");
    expect(settleShutterPresence("closing")).toBe("closed");
    for (const presence of all) {
      const settled = settleShutterPresence(presence);
      expect(settleShutterPresence(settled)).toBe(settled);
    }
  });

  it("pairs the fallback after the slide", () => {
    expect(SHUTTER_FALLBACK_MS).toBeGreaterThan(SHUTTER_MS);
  });
});

describe("settings shutter on path change", () => {
  const state = (presence: ShutterPresence, section: ShutterState["section"] = "connections") => ({
    presence,
    section,
  });

  it("opens without sliding when the blocker did not start the slide", () => {
    for (const reduced of [false, true]) {
      expect(nextShutterOnPath(state("closed"), "/settings/voice", reduced)).toEqual(
        state("open", "voice"),
      );
    }
  });

  it("reverses a close", () => {
    expect(nextShutterOnPath(state("closing"), "/settings/tags", false)).toEqual(
      state("opening", "tags"),
    );
    expect(nextShutterOnPath(state("closing"), "/settings/tags", true)).toEqual(
      state("open", "tags"),
    );
  });

  it("switches sections without moving", () => {
    expect(nextShutterOnPath(state("open"), "/settings/voice", false)).toEqual(
      state("open", "voice"),
    );
  });

  it("slides up when Settings is left, keeping the section", () => {
    expect(nextShutterOnPath(state("open", "tags"), "/", false)).toEqual(state("closing", "tags"));
    expect(nextShutterOnPath(state("open", "tags"), "/", true)).toEqual(state("closed", "tags"));
  });

  it("returns the same state when nothing changes", () => {
    const closed = state("closed");
    expect(nextShutterOnPath(closed, "/", false)).toBe(closed);
    const opening = state("opening");
    expect(nextShutterOnPath(opening, "/settings/connections", false)).toBe(opening);
  });
});
