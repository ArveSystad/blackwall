import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("uses defaults", () => {
    expect(parseConfig([], {})).toEqual({
      port: DEFAULT_PORT,
      open: true,
      dev: false,
      webDevOrigin: "http://127.0.0.1:5173",
      dataDir: join(homedir(), ".blackwall"),
    });
  });

  it("reads --port and --no-open", () => {
    expect(parseConfig(["--port", "5000", "--no-open"], {})).toMatchObject({
      port: 5000,
      open: false,
    });
  });

  it("prefers --port over BLACKWALL_PORT", () => {
    expect(parseConfig([], { BLACKWALL_PORT: "6000" }).port).toBe(6000);
    expect(parseConfig(["--port", "5000"], { BLACKWALL_PORT: "6000" }).port).toBe(5000);
  });

  it("reads BLACKWALL_HOME", () => {
    expect(parseConfig([], { BLACKWALL_HOME: "/tmp/bw" }).dataDir).toBe("/tmp/bw");
  });

  it("rejects invalid ports", () => {
    expect(() => parseConfig(["--port", "abc"], {})).toThrow(/Invalid port/);
    expect(() => parseConfig(["--port", "70000"], {})).toThrow(/Invalid port/);
  });
});
