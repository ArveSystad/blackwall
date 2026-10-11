import { describe, expect, it } from "vitest";
import { desktopPort } from "./port.js";

describe("desktopPort", () => {
  it("defaults to 4712", () => {
    expect(desktopPort({})).toBe(4712);
    expect(desktopPort({ BLACKWALL_DESKTOP_PORT: "" })).toBe(4712);
  });

  it("reads BLACKWALL_DESKTOP_PORT", () => {
    expect(desktopPort({ BLACKWALL_DESKTOP_PORT: "4713" })).toBe(4713);
  });

  it("rejects an invalid port", () => {
    for (const value of ["abc", "0", "65536", "1.5"]) {
      expect(() => desktopPort({ BLACKWALL_DESKTOP_PORT: value })).toThrow(
        /BLACKWALL_DESKTOP_PORT/,
      );
    }
  });
});
