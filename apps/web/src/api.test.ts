import { describe, expect, it } from "vitest";
import { socketUrl } from "./api";

describe("socketUrl", () => {
  it("uses ws: on http", () => {
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:4711" })).toBe("ws://127.0.0.1:4711/ws");
  });

  it("uses wss: on https", () => {
    expect(socketUrl({ protocol: "https:", host: "localhost:1" })).toBe("wss://localhost:1/ws");
  });
});
