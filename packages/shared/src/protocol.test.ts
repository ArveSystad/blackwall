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

  it("parses changed memories only with their repo id", () => {
    expect(parseServerEvent('{"type":"memories.changed","payload":{"repoId":"r1"}}')).toEqual({
      type: "memories.changed",
      payload: { repoId: "r1" },
    });
    expect(parseServerEvent('{"type":"memories.changed","payload":{}}')).toBeNull();
  });

  it("parses a project run and revives its timestamps", () => {
    const run = {
      repoId: "r1",
      runId: "run1",
      status: "failed",
      commands: ["pnpm dev"],
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:05.000Z",
      error: "`pnpm dev` exited with code 1",
    };
    const event = parseServerEvent(
      JSON.stringify({ type: "projectRun.upserted", payload: { run } }),
    );
    expect(event?.type).toBe("projectRun.upserted");
    if (event?.type !== "projectRun.upserted") return;
    expect(event.payload.run.startedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(event.payload.run.endedAt).toEqual(new Date("2026-01-01T00:00:05.000Z"));
  });

  it("parses project run output", () => {
    const payload = { repoId: "r1", runId: "run1", end: 6, text: "ready\n" };
    expect(parseServerEvent(JSON.stringify({ type: "projectRun.output", payload }))).toEqual({
      type: "projectRun.output",
      payload,
    });
    expect(
      parseServerEvent(
        JSON.stringify({ type: "projectRun.output", payload: { ...payload, end: -1 } }),
      ),
    ).toBeNull();
  });

  it("parses a data import", () => {
    expect(parseServerEvent('{"type":"data.imported","payload":{}}')).toEqual({
      type: "data.imported",
      payload: {},
    });
  });

  it("parses voice state, with and without what a submit created", () => {
    const voice = {
      busy: false,
      repoId: "r1",
      transcript: "confirm",
      activity: null,
      reply: "Created it",
      error: null,
      draft: null,
      created: null,
      clientId: null,
      actions: [],
    };
    const parse = (v: unknown) =>
      parseServerEvent(JSON.stringify({ type: "voice.upserted", payload: { voice: v } }));
    expect(parse(voice)).toEqual({ type: "voice.upserted", payload: { voice } });
    const created = { repoId: "r1", itemId: "b1", taskId: null, title: "Dark mode" };
    const draft = {
      id: "d1",
      repoId: "r1",
      title: "T",
      description: "",
      revision: 1,
      submitting: false,
    };
    expect(parse({ ...voice, created, draft })).toEqual({
      type: "voice.upserted",
      payload: { voice: { ...voice, created, draft } },
    });
    expect(parse({ ...voice, created: { ...created, itemId: "" } })).toBeNull();
  });

  it("parses a step's running usage", () => {
    const step = {
      id: "s1",
      runId: "r1",
      stage: "implement",
      agentId: "a1",
      cli: "claude",
      trust: null,
      trustForced: false,
      effort: null,
      round: 0,
      visit: 0,
      status: "running",
      sessionId: null,
      error: null,
      createdAt: 0,
      startedAt: 0,
      finishedAt: null,
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.01,
    };
    const event = parseServerEvent(JSON.stringify({ type: "step.usage", payload: { step } }));
    expect(event?.type === "step.usage" && event.payload.step).toMatchObject({
      outputTokens: 2,
      costUsd: 0.01,
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
