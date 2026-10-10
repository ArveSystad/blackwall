import type { ActiveAgentStep, Stage } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  DOT_SPACING,
  dotPosition,
  gridDots,
  layoutDots,
  PULSE_NEEDS_S,
  PULSE_RUNNING_S,
  pulseDelay,
  pulsePhase,
  stageChanges,
  type GridDot,
} from "./agent-dots";
import { makeTask } from "./test-fixtures";

function makeStep(taskId: string, id: string, createdAt: string): ActiveAgentStep {
  return {
    id,
    taskId,
    runId: "run1",
    stage: "implement",
    agentId: "a1",
    cli: "copilot",
    round: 0,
    visit: 0,
    status: "running",
    sessionId: null,
    error: null,
    createdAt: new Date(createdAt),
    startedAt: null,
    finishedAt: null,
  };
}

function dot(taskId: string, slot = 0): GridDot {
  return {
    key: `${taskId}:${slot}`,
    taskId,
    stepId: null,
    agentId: null,
    cli: null,
    slot,
    state: "running",
  };
}

function minDistance(spots: { x: number; y: number }[]): number {
  let min = Infinity;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) {
      min = Math.min(min, Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y));
    }
  }
  return min;
}

describe("gridDots", () => {
  it("gives a running task one dot per running step, oldest first", () => {
    const task = makeTask({ status: "running", stage: "implement" });
    const later = makeStep(task.id, "s2", "2026-10-08T10:05:00.000Z");
    const earlier = makeStep(task.id, "s1", "2026-10-08T10:01:00.000Z");
    const dots = gridDots([task], [later, earlier]);
    expect(dots.map((d) => [d.key, d.stepId, d.cli, d.state])).toEqual([
      [`${task.id}:0`, "s1", "copilot", "running"],
      [`${task.id}:1`, "s2", "copilot", "running"],
    ]);
  });

  it("gives a running task between steps one dot with no step", () => {
    const task = makeTask({ status: "running", stage: "inform" });
    expect(gridDots([task], [])).toEqual([
      {
        key: `${task.id}:0`,
        taskId: task.id,
        stepId: null,
        agentId: null,
        cli: null,
        slot: 0,
        state: "running",
      },
    ]);
  });

  it("gives needs-you and queued tasks one dot each, on the running dot's key", () => {
    const needs = makeTask({ status: "needs-you", gate: "plan-approval" });
    const queued = makeTask({ status: "queued", createdAt: new Date("2026-10-08T11:00:00.000Z") });
    expect(gridDots([queued, needs], []).map((d) => [d.key, d.state])).toEqual([
      [`${needs.id}:0`, "needs-you"],
      [`${queued.id}:0`, "queued"],
    ]);
  });

  it("gives a done, unarchived task one done dot on the running dot's key", () => {
    const done = makeTask({ status: "done" });
    expect(gridDots([done], [])).toEqual([
      {
        key: `${done.id}:0`,
        taskId: done.id,
        stepId: null,
        agentId: null,
        cli: null,
        slot: 0,
        state: "done",
      },
    ]);
  });

  it("leaves out failed, interrupted and archived tasks", () => {
    const archivedAt = new Date("2026-10-08T12:00:00.000Z");
    const tasks = [
      makeTask({ status: "failed" }),
      makeTask({ status: "interrupted" }),
      makeTask({ status: "running", archivedAt }),
      makeTask({ status: "done", archivedAt }),
    ];
    expect(gridDots(tasks, [])).toEqual([]);
  });

  it("keeps a done task in creation order among running tasks", () => {
    const first = makeTask({ status: "running", createdAt: new Date("2026-10-08T09:00:00.000Z") });
    const done = makeTask({ status: "done", createdAt: new Date("2026-10-08T10:00:00.000Z") });
    const last = makeTask({ status: "running", createdAt: new Date("2026-10-08T11:00:00.000Z") });
    expect(gridDots([last, done, first], []).map((d) => [d.taskId, d.state])).toEqual([
      [first.id, "running"],
      [done.id, "done"],
      [last.id, "running"],
    ]);
  });
});

describe("dotPosition", () => {
  it("is stable and stays on the floor", () => {
    for (let i = 0; i < 200; i++) {
      const id = `task-${i}`;
      const spot = dotPosition(id);
      expect(dotPosition(id)).toEqual(spot);
      expect(spot.x).toBeGreaterThanOrEqual(0.08);
      expect(spot.x).toBeLessThanOrEqual(0.92);
      expect(spot.y).toBeGreaterThanOrEqual(0.64);
      expect(spot.y).toBeLessThanOrEqual(0.9);
    }
  });
});

describe("layoutDots", () => {
  /** Two task ids whose home spots collide in a `width` × `height` pane. */
  function collidingIds(width: number, height: number): [string, string] {
    const ids = Array.from({ length: 400 }, (_, i) => `t-${i}`);
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const pa = dotPosition(a);
        const pb = dotPosition(b);
        if (Math.hypot((pa.x - pb.x) * width, (pa.y - pb.y) * height) < DOT_SPACING) return [a, b];
      }
    }
    throw new Error("no colliding ids");
  }

  it("moves a dot that would land on another apart", () => {
    const [a, b] = collidingIds(750, 300);
    const layout = layoutDots([dot(a), dot(b)], 750, 300);
    expect(minDistance([...layout.values()])).toBeGreaterThanOrEqual(DOT_SPACING - 1e-6);
  });

  it("keeps a task's extra slots inside the pane and apart", () => {
    const id = Array.from({ length: 1000 }, (_, i) => `edge-${i}`).find(
      (candidate) => dotPosition(candidate).x > 0.88,
    )!;
    const layout = layoutDots([dot(id, 0), dot(id, 1), dot(id, 2)], 400, 300);
    const spots = [...layout.values()];
    expect(spots).toHaveLength(3);
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThanOrEqual(16);
      expect(spot.x).toBeLessThanOrEqual(384);
    }
    expect(minDistance(spots)).toBeGreaterThanOrEqual(DOT_SPACING - 1e-6);
  });

  it("is deterministic and keeps earlier dots where they are", () => {
    const dots = ["x1", "x2", "x3", "x4", "x5"].map((id) => dot(id));
    const first = layoutDots(dots, 600, 400);
    expect(layoutDots(dots, 600, 400)).toEqual(first);
    const grown = layoutDots([...dots, dot("x6")], 600, 400);
    for (const d of dots) expect(grown.get(d.key)).toEqual(first.get(d.key));
  });

  it("keeps every dot within the floor band, even in a short pane", () => {
    const layout = layoutDots(
      ["y1", "y2", "y3"].map((id) => dot(id)),
      600,
      60,
    );
    for (const spot of layout.values()) expect(spot.y).toBeCloseTo(0.77 * 60);
  });
});

describe("stageChanges", () => {
  it("reports tasks whose known stage changed", () => {
    const task = makeTask({ stage: "inform" });
    const empty = new Map<string, Stage | null>();
    expect(stageChanges(empty, [task])).toEqual([]);
    expect(stageChanges(new Map([[task.id, "inform"]]), [task])).toEqual([]);
    expect(stageChanges(new Map([[task.id, "plan-review"]]), [task])).toEqual([task.id]);
    expect(stageChanges(new Map([[task.id, null]]), [task])).toEqual([task.id]);
  });
});

describe("pulsePhase", () => {
  it("is stable for the same id", () => {
    expect(pulsePhase("task-a")).toBe(pulsePhase("task-a"));
  });

  it("lies in [0, 1)", () => {
    for (let i = 0; i < 200; i++) {
      const phase = pulsePhase(`task-${i}`);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it("differs between ids", () => {
    expect(pulsePhase("task-a")).not.toBe(pulsePhase("task-b"));
  });
});

describe("pulseDelay", () => {
  it("is the phase as a negative share of the period", () => {
    expect(pulseDelay("task-a", PULSE_RUNNING_S)).toBe(-pulsePhase("task-a") * PULSE_RUNNING_S);
  });

  it("lies in (−period, 0]", () => {
    for (const period of [PULSE_RUNNING_S, PULSE_NEEDS_S]) {
      for (let i = 0; i < 200; i++) {
        const delay = pulseDelay(`task-${i}`, period);
        expect(delay).toBeGreaterThan(-period);
        expect(delay).toBeLessThanOrEqual(0);
      }
    }
  });

  it("is shared by a task's dots", () => {
    expect(pulseDelay("task-a", PULSE_NEEDS_S)).toBe(pulseDelay("task-a", PULSE_NEEDS_S));
  });
});
