import { describe, expect, it } from "vitest";
import { parseClientEvent, parseServerEvent } from "./protocol.js";

describe("protocol", () => {
  it("parses a valid ping", () => {
    expect(parseClientEvent('{"type":"ping","payload":{"id":"1"}}')).toEqual({
      type: "ping",
      payload: { id: "1" },
    });
  });

  it("rejects malformed or unknown client events", () => {
    expect(parseClientEvent("not json")).toBeNull();
    expect(parseClientEvent('{"type":"nope","payload":{}}')).toBeNull();
    expect(parseClientEvent('{"type":"ping","payload":{}}')).toBeNull();
  });

  it("parses a pong", () => {
    expect(parseServerEvent('{"type":"pong","payload":{"id":"1","serverTime":5}}')).toEqual({
      type: "pong",
      payload: { id: "1", serverTime: 5 },
    });
  });
});
