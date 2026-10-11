import { describe, expect, it } from "vitest";
import { parseDesktopChildMessage, parseDesktopMainMessage } from "./desktop.js";

describe("parseDesktopChildMessage", () => {
  it("parses each child message", () => {
    const messages = [
      { type: "ready", launchUrl: "http://127.0.0.1:4712/?t=abc", port: 4712 },
      { type: "failed", message: "boom" },
      { type: "status", runningAgents: 2 },
      { type: "stopped" },
    ];
    for (const message of messages) expect(parseDesktopChildMessage(message)).toEqual(message);
  });

  it("rejects junk", () => {
    for (const value of [
      null,
      "ready",
      {},
      { type: "ready", launchUrl: "x" },
      { type: "status", runningAgents: -1 },
      { type: "shutdown" },
    ]) {
      expect(parseDesktopChildMessage(value)).toBeNull();
    }
  });
});

describe("parseDesktopMainMessage", () => {
  it("parses each main message", () => {
    expect(parseDesktopMainMessage({ type: "status" })).toEqual({ type: "status" });
    expect(parseDesktopMainMessage({ type: "shutdown" })).toEqual({ type: "shutdown" });
  });

  it("rejects junk", () => {
    for (const value of [undefined, 1, { type: "stopped" }, { kind: "status" }]) {
      expect(parseDesktopMainMessage(value)).toBeNull();
    }
  });
});
