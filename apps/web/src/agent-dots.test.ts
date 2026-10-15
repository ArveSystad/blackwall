import type { ActiveAgentStep, Stage } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  DOT_SPACING,
  doneTransitions,
  dotPosition,
  gridDots,
  layoutDots,
  PULSE_NEEDS_S,
  PULSE_RUNNING_S,
  pulseDelay,
  pulsePhase,
  runningLabel,
  runningLabelSuffix,
  runningTaskCount,
  stageChanges,
  statusMap,
  SUPERNOVA_FLASH_MS,
  SUPERNOVA_MS,
  supernovaLifetimeMs,
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
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    subagents: [],
  };
}

function withSubagents(step: ActiveAgentStep, ...starts: [string, string][]): ActiveAgentStep {
  return {
    ...step,
    subagents: starts.map(([id, startedAt]) => ({
      id,
      agentType: "blackwall-worker",
      description: `Job ${id}`,
      startedAt: new Date(startedAt),
    })),
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
    subagent: null,
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

  it("puts open sub-agents after the step dots, oldest first, on their own keys", () => {
    const task = makeTask({ status: "running", stage: "implement" });
    const first = withSubagents(makeStep(task.id, "s1", "2026-10-08T10:01:00.000Z"), [
      "t2",
      "2026-10-08T10:07:00.000Z",
    ]);
    const second = withSubagents(makeStep(task.id, "s2", "2026-10-08T10:05:00.000Z"), [
      "t1",
      "2026-10-08T10:06:00.000Z",
    ]);
    const dots = gridDots([task], [second, first]);
    expect(dots.map((d) => [d.key, d.stepId, d.slot, d.subagent?.id ?? null])).toEqual([
      [`${task.id}:0`, "s1", 0, null],
      [`${task.id}:1`, "s2", 1, null],
      [`${task.id}:sub:t1`, "s2", 2, "t1"],
      [`${task.id}:sub:t2`, "s1", 3, "t2"],
    ]);
    expect(dots[2]).toMatchObject({
      state: "running",
      agentId: "a1",
      subagent: { id: "t1", agentType: "blackwall-worker", description: "Job t1" },
    });
    expect(runningTaskCount(dots)).toBe(1);
    const layout = layoutDots(dots, 600, 400);
    expect(minDistance([...layout.values()])).toBeGreaterThanOrEqual(DOT_SPACING - 1e-6);
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
        subagent: null,
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
        subagent: null,
      },
    ]);
  });

  it("gives failed and interrupted unarchived tasks one dot each on the running dot's key", () => {
    const failed = makeTask({ status: "failed", error: "boom" });
    const interrupted = makeTask({
      status: "interrupted",
      createdAt: new Date("2026-10-08T11:00:00.000Z"),
    });
    expect(gridDots([interrupted, failed], []).map((d) => [d.key, d.state])).toEqual([
      [`${failed.id}:0`, "failed"],
      [`${interrupted.id}:0`, "interrupted"],
    ]);
  });

  it("leaves out archived tasks", () => {
    const archivedAt = new Date("2026-10-08T12:00:00.000Z");
    const tasks = [
      makeTask({ status: "running", archivedAt }),
      makeTask({ status: "done", archivedAt }),
      makeTask({ status: "failed", archivedAt }),
      makeTask({ status: "interrupted", archivedAt }),
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

  it("keeps a failed task in creation order among running tasks", () => {
    const first = makeTask({ status: "running", createdAt: new Date("2026-10-08T09:00:00.000Z") });
    const failed = makeTask({ status: "failed", createdAt: new Date("2026-10-08T10:00:00.000Z") });
    const last = makeTask({ status: "running", createdAt: new Date("2026-10-08T11:00:00.000Z") });
    expect(gridDots([last, failed, first], []).map((d) => [d.taskId, d.state])).toEqual([
      [first.id, "running"],
      [failed.id, "failed"],
      [last.id, "running"],
    ]);
  });
});

describe("runningTaskCount", () => {
  it("counts a task's parallel running steps once", () => {
    const task = makeTask({ status: "running", stage: "implement" });
    const steps = [
      makeStep(task.id, "s1", "2026-10-08T10:01:00.000Z"),
      makeStep(task.id, "s2", "2026-10-08T10:05:00.000Z"),
    ];
    expect(runningTaskCount(gridDots([task], steps))).toBe(1);
  });

  it("counts a running task between steps", () => {
    const task = makeTask({ status: "running", stage: "inform" });
    expect(runningTaskCount(gridDots([task], []))).toBe(1);
  });

  it("leaves out needs-you, queued, done, interrupted and failed tasks", () => {
    const tasks = [
      makeTask({ status: "running" }),
      makeTask({ status: "needs-you", gate: "plan-approval" }),
      makeTask({ status: "queued" }),
      makeTask({ status: "done" }),
      makeTask({ status: "interrupted" }),
      makeTask({ status: "failed", error: "boom" }),
      makeTask({ status: "running" }),
    ];
    expect(runningTaskCount(gridDots(tasks, []))).toBe(2);
  });

  it("is 0 with no dots", () => {
    expect(runningTaskCount([])).toBe(0);
  });
});

describe("runningLabel", () => {
  it("is singular for one task and plural otherwise", () => {
    expect(runningLabel(1)).toBe("1 task running");
    expect(runningLabel(2)).toBe("2 tasks running");
  });
});

describe("runningLabelSuffix", () => {
  it("is the label after its number", () => {
    expect(runningLabelSuffix(1)).toBe(" task running");
    expect(runningLabelSuffix(3)).toBe(" tasks running");
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

describe("doneTransitions", () => {
  it("reports a known running task that is now done", () => {
    const running = makeTask({ status: "running" });
    const done = { ...running, status: "done" as const };
    expect(doneTransitions(statusMap([running]), [done])).toEqual([running.id]);
  });

  it("reports it once: the next snapshot of the same done task is quiet", () => {
    const done = makeTask({ status: "done" });
    expect(doneTransitions(statusMap([done]), [done])).toEqual([]);
  });

  it("is quiet on a first snapshot seeded from tasks already done, as on reload", () => {
    const tasks = [makeTask({ status: "done" }), makeTask({ status: "done" })];
    expect(doneTransitions(statusMap(tasks), tasks)).toEqual([]);
  });

  it("ignores a task first seen already done", () => {
    expect(doneTransitions(new Map(), [makeTask({ status: "done" })])).toEqual([]);
  });

  it("reports needs-you and failed tasks that turn done", () => {
    const needs = makeTask({ status: "needs-you", gate: "plan-approval" });
    const failed = makeTask({ status: "failed", error: "boom" });
    const prev = statusMap([needs, failed]);
    const next = [needs, failed].map((t) => ({ ...t, status: "done" as const }));
    expect(doneTransitions(prev, next)).toEqual([needs.id, failed.id]);
  });

  it("keeps tasks order for a batch, which sets the stagger", () => {
    const a = makeTask({ status: "running" });
    const b = makeTask({ status: "running" });
    const prev = statusMap([a, b]);
    const next = [b, a].map((t) => ({ ...t, status: "done" as const }));
    expect(doneTransitions(prev, next)).toEqual([b.id, a.id]);
  });
});

describe("supernovaLifetimeMs", () => {
  it("is the full burst, or the short flash under reduced motion", () => {
    expect(supernovaLifetimeMs(false)).toBe(SUPERNOVA_MS);
    expect(supernovaLifetimeMs(true)).toBe(SUPERNOVA_FLASH_MS);
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
