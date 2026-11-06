import type { Finding, ServerEvent, Step } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  PACKET_MAX_IN_FLIGHT,
  PACKET_SEEN_CAP,
  PACKET_TRAVEL_MS,
  admitPacket,
  packetFor,
  packetPath,
  type PacketResolve,
} from "./data-packets";

const NOW = 1_000_000;

const resolve: PacketResolve = {
  run: (runId) => (runId === "r1" ? "t1" : undefined),
  step: (stepId) => (stepId === "s1" ? "t1" : undefined),
};

function stepUpserted(overrides: Partial<Step>): ServerEvent {
  const step = {
    id: "s1",
    runId: "r1",
    stage: "implementation",
    agentId: "a1",
    status: "running",
    ...overrides,
  } as Step;
  return { type: "step.upserted", payload: { step } };
}

function stepEvent(type: string, payload: unknown, seq = 1, stepId = "s1"): ServerEvent {
  return {
    type: "step.event",
    payload: { event: { stepId, seq, type, payload, createdAt: new Date(NOW) } },
  };
}

function findingUpserted(createdAt: number, updatedAt = createdAt, id = "f1"): ServerEvent {
  const finding = {
    id,
    taskId: "t1",
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  } as Finding;
  return { type: "finding.upserted", payload: { finding } };
}

describe("packetPath", () => {
  it("runs right then up for a dot left of the tower", () => {
    const path = packetPath({ x: 100, y: 500 }, { x: 400, base: 300 });
    expect(path.dx).toBe(300);
    expect(path.dy).toBe(-200);
    expect(path.xMs).toBe(660);
    expect(path.yMs).toBe(440);
    expect(path.xMs + path.yMs).toBe(PACKET_TRAVEL_MS);
  });

  it("runs left for a dot right of the tower", () => {
    const path = packetPath({ x: 500, y: 400 }, { x: 200, base: 300 });
    expect(path.dx).toBe(-300);
    expect(path.dy).toBe(-100);
    expect(path.xMs + path.yMs).toBe(PACKET_TRAVEL_MS);
  });

  it("gives the sideways leg no time when the dot is under the tower", () => {
    expect(packetPath({ x: 200, y: 400 }, { x: 200, base: 300 })).toEqual({
      dx: 0,
      dy: -100,
      xMs: 0,
      yMs: PACKET_TRAVEL_MS,
    });
  });

  it("stays finite for a zero-length path", () => {
    const path = packetPath({ x: 200, y: 300 }, { x: 200, base: 300 });
    expect(path).toEqual({ dx: 0, dy: 0, xMs: 0, yMs: PACKET_TRAVEL_MS });
  });
});

describe("admitPacket", () => {
  it("lets one packet per task through every 2 s", () => {
    const last = new Map<string, number>();
    expect(admitPacket(last, "t1", 0, 0)).toBe(true);
    expect(admitPacket(last, "t1", 1999, 0)).toBe(false);
    expect(admitPacket(last, "t1", 2000, 0)).toBe(true);
  });

  it("throttles tasks independently", () => {
    const last = new Map<string, number>();
    expect(admitPacket(last, "t1", 0, 0)).toBe(true);
    expect(admitPacket(last, "t2", 10, 1)).toBe(true);
  });

  it("rejects past the in-flight cap without recording it", () => {
    const last = new Map<string, number>();
    expect(admitPacket(last, "t7", 0, PACKET_MAX_IN_FLIGHT - 1)).toBe(true);
    expect(admitPacket(last, "t8", 0, PACKET_MAX_IN_FLIGHT)).toBe(false);
    expect(last.has("t8")).toBe(false);
  });
});

describe("packetFor: steps and checks", () => {
  it("sends a step packet when a step succeeds, none while it runs", () => {
    expect(packetFor(stepUpserted({ status: "running" }), resolve, new Set(), NOW)).toBeNull();
    expect(packetFor(stepUpserted({ status: "succeeded" }), resolve, new Set(), NOW)).toEqual({
      taskId: "t1",
      kind: "step",
    });
  });

  it("sends a commit packet once for a harness Checks step", () => {
    const seen = new Set<string>();
    const checks = stepUpserted({ agentId: null, stage: "checks", status: "running" });
    expect(packetFor(checks, resolve, seen, NOW)).toEqual({ taskId: "t1", kind: "commit" });
    expect(packetFor(checks, resolve, seen, NOW)).toBeNull();
  });

  it("reads a finished check's outcome", () => {
    const kind = (payload: unknown) =>
      packetFor(stepEvent("check.finished", payload), resolve, new Set(), NOW)?.kind;
    expect(kind({ exitCode: 0, timedOut: false })).toBe("check-pass");
    expect(kind({ exitCode: 1, timedOut: false })).toBe("check-fail");
    expect(kind({ exitCode: null, timedOut: false })).toBe("check-fail");
    expect(kind({ exitCode: 0, timedOut: true })).toBe("check-fail");
  });

  it("ignores tool calls and other step events", () => {
    expect(packetFor(stepEvent("tool-call", {}), resolve, new Set(), NOW)).toBeNull();
    expect(packetFor(stepEvent("check.started", {}), resolve, new Set(), NOW)).toBeNull();
  });

  it("drops events whose task is unknown", () => {
    expect(
      packetFor(stepUpserted({ runId: "r9", status: "succeeded" }), resolve, new Set(), NOW),
    ).toBeNull();
    expect(
      packetFor(stepEvent("check.finished", { exitCode: 0 }, 1, "s9"), resolve, new Set(), NOW),
    ).toBeNull();
  });

  it("fires each key once", () => {
    const seen = new Set<string>();
    const done = stepUpserted({ status: "succeeded" });
    expect(packetFor(done, resolve, seen, NOW)).not.toBeNull();
    expect(packetFor(done, resolve, seen, NOW)).toBeNull();
    const check = stepEvent("check.finished", { exitCode: 0, timedOut: false }, 3);
    expect(packetFor(check, resolve, seen, NOW)).not.toBeNull();
    expect(packetFor(check, resolve, seen, NOW)).toBeNull();
  });

  it("caps the seen keys, evicting the oldest first", () => {
    const seen = new Set<string>();
    const done = stepUpserted({ status: "succeeded" });
    expect(packetFor(done, resolve, seen, NOW)).not.toBeNull();
    for (let seq = 1; seq <= PACKET_SEEN_CAP; seq++) {
      packetFor(stepEvent("check.finished", { exitCode: 0 }, seq), resolve, seen, NOW);
    }
    expect(seen.size).toBe(PACKET_SEEN_CAP);
    expect(seen.has("step:s1")).toBe(false);
    expect(packetFor(done, resolve, seen, NOW)).not.toBeNull();
  });
});

describe("packetFor: findings", () => {
  it("sends a packet for a new finding whose timestamps differ", () => {
    const seen = new Set<string>();
    const fresh = findingUpserted(NOW - 5, NOW - 4);
    expect(packetFor(fresh, resolve, seen, NOW)).toEqual({ taskId: "t1", kind: "finding" });
    expect(packetFor(fresh, resolve, seen, NOW)).toBeNull();
  });

  it("ignores an override or merge into an old finding", () => {
    expect(packetFor(findingUpserted(NOW - 31_000, NOW), resolve, new Set(), NOW)).toBeNull();
  });

  it("counts a finding exactly 30 s old as new", () => {
    expect(packetFor(findingUpserted(NOW - 30_000), resolve, new Set(), NOW)?.kind).toBe("finding");
  });

  it("counts a finding from the future (clock skew) as new", () => {
    expect(packetFor(findingUpserted(NOW + 500), resolve, new Set(), NOW)?.kind).toBe("finding");
  });
});
