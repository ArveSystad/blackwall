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

  it("parses deleted findings", () => {
    const raw = '{"type":"finding.deleted","payload":{"taskId":"t1","findingIds":["f1","f2"]}}';
    expect(parseServerEvent(raw)).toEqual({
      type: "finding.deleted",
      payload: { taskId: "t1", findingIds: ["f1", "f2"] },
    });
  });

  it("parses a data import", () => {
    expect(parseServerEvent('{"type":"data.imported","payload":{}}')).toEqual({
      type: "data.imported",
      payload: {},
    });
  });

  it("parses a step event and revives its timestamp", () => {
    const raw = JSON.stringify({
      type: "step.event",
      payload: {
        event: { stepId: "s1", seq: 1, type: "text", payload: { text: "hi" }, createdAt: 0 },
      },
    });
    const event = parseServerEvent(raw);
    expect(event?.type).toBe("step.event");
    expect(event?.type === "step.event" && event.payload.event.createdAt).toEqual(new Date(0));
  });
});
