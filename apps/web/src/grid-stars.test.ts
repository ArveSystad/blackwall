import type { Task, TaskDoneTime } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  STAR_OPACITY,
  STAR_SIZE,
  STAR_SPACING,
  TWINKLE_S,
  layoutStars,
  msUntilNextMidnight,
  nextArrivals,
  signZone,
  starsToday,
  type TodayStar,
} from "./grid-stars";
import { makeTask } from "./test-fixtures";

const NOW = new Date(2026, 10, 6, 15, 0, 0);

function byId(tasks: readonly Task[]): Map<string, Task> {
  return new Map(tasks.map((t) => [t.id, t]));
}

function todayStars(count: number): TodayStar[] {
  return Array.from({ length: count }, (_, i) => ({
    task: makeTask({ id: `star-${i}`, status: "done" }),
    doneAt: new Date(2026, 10, 6, 9, 0, i),
  }));
}

describe("starsToday", () => {
  it("keeps tasks done from local midnight and drops the day before", () => {
    const a = makeTask({ status: "done" });
    const b = makeTask({ status: "done" });
    const times: TaskDoneTime[] = [
      { taskId: a.id, doneAt: new Date(2026, 10, 6, 0, 0, 0) },
      { taskId: b.id, doneAt: new Date(2026, 10, 5, 23, 59, 59) },
    ];
    expect(starsToday(times, byId([a, b]), NOW).map((s) => s.task.id)).toEqual([a.id]);
  });

  it("includes archived done tasks", () => {
    const a = makeTask({ status: "done", archivedAt: new Date(2026, 10, 6, 10) });
    const times = [{ taskId: a.id, doneAt: new Date(2026, 10, 6, 9) }];
    expect(starsToday(times, byId([a]), NOW)).toHaveLength(1);
  });

  it("drops tasks that are not done or missing", () => {
    const reopened = makeTask({ status: "running" });
    const times = [
      { taskId: reopened.id, doneAt: new Date(2026, 10, 6, 9) },
      { taskId: "gone", doneAt: new Date(2026, 10, 6, 9) },
    ];
    expect(starsToday(times, byId([reopened]), NOW)).toEqual([]);
  });

  it("sorts by done time, then id", () => {
    const a = makeTask({ id: "a", status: "done" });
    const b = makeTask({ id: "b", status: "done" });
    const c = makeTask({ id: "c", status: "done" });
    const times = [
      { taskId: "c", doneAt: new Date(2026, 10, 6, 8) },
      { taskId: "b", doneAt: new Date(2026, 10, 6, 9) },
      { taskId: "a", doneAt: new Date(2026, 10, 6, 9) },
    ];
    expect(starsToday(times, byId([a, b, c]), NOW).map((s) => s.task.id)).toEqual(["c", "a", "b"]);
  });

  it("is uncapped", () => {
    const stars = todayStars(120);
    const times = stars.map((s) => ({ taskId: s.task.id, doneAt: s.doneAt }));
    expect(starsToday(times, byId(stars.map((s) => s.task)), NOW)).toHaveLength(120);
  });
});

describe("layoutStars", () => {
  const W = 1200;
  const H = 800;

  it("is deterministic", () => {
    const stars = todayStars(10);
    expect(layoutStars(stars, W, H)).toEqual(layoutStars(stars, W, H));
  });

  it("keeps an earlier star's spot when a newer one arrives", () => {
    const stars = todayStars(11);
    const before = layoutStars(stars.slice(0, 10), W, H);
    const after = layoutStars(stars, W, H);
    for (const [id, spot] of before) expect(after.get(id)).toEqual(spot);
  });

  it("keeps stars in the sky band, out of the sign's zone and spaced when there is room", () => {
    const layout = layoutStars(todayStars(20), W, H);
    const zone = signZone(W, H);
    const spots = [...layout.values()];
    for (const s of spots) {
      expect(s.x).toBeGreaterThanOrEqual(8);
      expect(s.x).toBeLessThanOrEqual(W - 8);
      expect(s.y).toBeGreaterThanOrEqual(0.04 * H);
      expect(s.y).toBeLessThanOrEqual(0.54 * H);
      const inZone = s.x <= zone.right && s.y >= zone.top && s.y <= zone.bottom;
      expect(inZone).toBe(false);
    }
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        expect(
          Math.hypot(spots[i]!.x - spots[j]!.x, spots[i]!.y - spots[j]!.y),
        ).toBeGreaterThanOrEqual(STAR_SPACING - 1e-6);
  });

  it("keeps sizes, opacities and twinkles in range", () => {
    for (const s of layoutStars(todayStars(50), W, H).values()) {
      expect(s.size).toBeGreaterThanOrEqual(STAR_SIZE.min);
      expect(s.size).toBeLessThanOrEqual(STAR_SIZE.max);
      expect(s.opacity).toBeGreaterThanOrEqual(STAR_OPACITY.min);
      expect(s.opacity).toBeLessThanOrEqual(STAR_OPACITY.max);
      expect(s.twinkleS).toBeGreaterThanOrEqual(TWINKLE_S.min);
      expect(s.twinkleS).toBeLessThanOrEqual(TWINKLE_S.max);
      expect(s.twinkleDelayS).toBeLessThanOrEqual(0);
      expect(s.twinkleDelayS).toBeGreaterThan(-s.twinkleS - 1e-9);
    }
  });

  it("places every star on a crowded day", () => {
    const layout = layoutStars(todayStars(120), W, H);
    expect(layout.size).toBe(120);
    for (const s of layout.values()) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
      expect(s.y).toBeGreaterThanOrEqual(0.04 * H);
      expect(s.y).toBeLessThanOrEqual(0.54 * H);
    }
  });

  it("returns finite values for an empty pane", () => {
    for (const s of layoutStars(todayStars(3), 0, 0).values()) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
    }
  });
});

describe("nextArrivals", () => {
  it("seeds without arrivals", () => {
    const { seen, arrived } = nextArrivals(null, ["a", "b"]);
    expect([...seen]).toEqual(["a", "b"]);
    expect(arrived).toEqual([]);
  });

  it("returns only new ids and marks them seen", () => {
    const { seen, arrived } = nextArrivals(new Set(["a"]), ["a", "b"]);
    expect(arrived).toEqual(["b"]);
    expect(seen.has("b")).toBe(true);
  });

  it("does not arrive others when an id drops out", () => {
    const { arrived } = nextArrivals(new Set(["a", "b"]), ["b"]);
    expect(arrived).toEqual([]);
  });
});

describe("msUntilNextMidnight", () => {
  it("counts to the next local midnight", () => {
    expect(msUntilNextMidnight(new Date(2026, 10, 6, 23, 0, 0))).toBe(60 * 60 * 1000);
    expect(msUntilNextMidnight(new Date(2026, 10, 6, 0, 0, 0))).toBe(24 * 60 * 60 * 1000);
  });
});
