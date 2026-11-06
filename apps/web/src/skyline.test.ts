import { describe, expect, it } from "vitest";
import { HOME_X, HORIZON_Y } from "./agent-dots";
import {
  BACKLOG_CAP,
  hotRepo,
  layoutSkyline,
  MIN_H,
  repoActivity,
  towerHeight,
  windowColumns,
} from "./skyline";
import { makeTask } from "./test-fixtures";

function repo(id: string, favorite = false) {
  return { id, name: `Repo ${id}`, favorite };
}

const none = new Map<string, number>();
const idle = new Map<string, { running: number; needs: number }>();

describe("layoutSkyline", () => {
  it("returns no towers without repos", () => {
    expect(layoutSkyline([], none, idle, 1000, 800)).toEqual([]);
  });

  it("keeps the repos' order, evenly spaced inside the dots' band", () => {
    const towers = layoutSkyline([repo("c"), repo("a"), repo("b")], none, idle, 1000, 800);
    expect(towers.map((t) => t.repoId)).toEqual(["c", "a", "b"]);
    const xs = towers.map((t) => t.x);
    const pitch = xs[1]! - xs[0]!;
    expect(pitch).toBeGreaterThan(0);
    expect(xs[2]! - xs[1]!).toBeCloseTo(pitch);
    for (const x of xs) {
      expect(x).toBeGreaterThan(HOME_X.min * 1000);
      expect(x).toBeLessThan(HOME_X.max * 1000);
    }
  });

  it("centres a single repo", () => {
    const [tower] = layoutSkyline([repo("a")], none, idle, 1000, 800);
    expect(tower?.x).toBeCloseTo(500);
  });

  it("stands every tower on the horizon, clear of the dot floor", () => {
    const counts = new Map([
      ["a", 0],
      ["b", 500],
    ]);
    for (const tower of layoutSkyline([repo("a"), repo("b")], counts, idle, 1000, 800)) {
      expect(tower.base).toBeCloseTo(HORIZON_Y * 800);
      expect(tower.top).toBeCloseTo(tower.base - tower.height);
      expect(tower.top).toBeGreaterThanOrEqual(0);
      expect(tower.base).toBeLessThan(0.64 * 800);
    }
  });

  it("clamps the width between 4 and 24px and splits windows into two columns from 14px", () => {
    const one = layoutSkyline([repo("a")], none, idle, 1000, 800);
    expect(one[0]?.width).toBe(24);
    const many = Array.from({ length: 200 }, (_, i) => repo(`r${i}`));
    expect(layoutSkyline(many, none, idle, 400, 800)[0]?.width).toBe(4);
    expect(windowColumns(13.9)).toBe(1);
    expect(windowColumns(14)).toBe(2);
  });

  it("lights needs-you windows first, then running, from the bottom", () => {
    const activity = new Map([["a", { running: 2, needs: 1 }]]);
    const [tower] = layoutSkyline([repo("a")], new Map([["a", 64]]), activity, 1000, 800);
    expect(tower?.windows.slice(0, 4)).toEqual(["needs-you", "running", "running", "off"]);
  });

  it("caps the lit windows at the window count but keeps the exact counts", () => {
    const activity = new Map([["a", { running: 50, needs: 50 }]]);
    const [tower] = layoutSkyline([repo("a")], none, activity, 1000, 800);
    // An empty backlog: MIN_H tall, one row of two windows.
    expect(tower?.windows).toEqual(["needs-you", "needs-you"]);
    expect(tower?.running).toBe(50);
    expect(tower?.needs).toBe(50);
  });

  it("passes the favourite flag and the backlog count through", () => {
    const [fav, plain] = layoutSkyline(
      [repo("a", true), repo("b")],
      new Map([["a", 7]]),
      idle,
      1000,
      800,
    );
    expect(fav?.favorite).toBe(true);
    expect(fav?.backlog).toBe(7);
    expect(plain?.favorite).toBe(false);
    expect(plain?.backlog).toBe(0);
  });
});

describe("towerHeight", () => {
  it("starts at MIN_H, never shrinks and stops growing at the cap", () => {
    expect(towerHeight(0, 800)).toBe(MIN_H);
    let previous = 0;
    for (let n = 0; n <= 100; n++) {
      const h = towerHeight(n, 800);
      expect(h).toBeGreaterThanOrEqual(previous);
      previous = h;
    }
    expect(towerHeight(BACKLOG_CAP, 800)).toBe(towerHeight(BACKLOG_CAP + 100, 800));
  });

  it("grows on a log curve", () => {
    const h = (n: number) => towerHeight(n, 800);
    expect(h(4) - h(0)).toBeGreaterThan(h(64) - h(60));
  });

  it("shrinks the cap on short panes, never below MIN_H", () => {
    expect(towerHeight(BACKLOG_CAP, 2000)).toBe(120);
    expect(towerHeight(BACKLOG_CAP, 300)).toBeCloseTo(54);
    expect(towerHeight(BACKLOG_CAP, 20)).toBe(MIN_H);
  });
});

describe("repoActivity", () => {
  it("counts running and needs-you tasks per repo, skipping archived and other statuses", () => {
    const activity = repoActivity([
      makeTask({ repoId: "a", status: "running" }),
      makeTask({ repoId: "a", status: "running" }),
      makeTask({ repoId: "a", status: "needs-you" }),
      makeTask({ repoId: "b", status: "needs-you" }),
      makeTask({ repoId: "b", status: "running", archivedAt: new Date() }),
      makeTask({ repoId: "b", status: "done" }),
      makeTask({ repoId: "c", status: "queued" }),
    ]);
    expect(activity.get("a")).toEqual({ running: 2, needs: 1 });
    expect(activity.get("b")).toEqual({ running: 0, needs: 1 });
    expect(activity.has("c")).toBe(false);
  });
});

describe("hotRepo", () => {
  it("lights the hot tower's repo or the hot dot's task's repo", () => {
    const tasks = new Map([["t1", { repoId: "a" }]]);
    expect(hotRepo(null, tasks)).toBeNull();
    expect(hotRepo({ repoId: "b" }, tasks)).toBe("b");
    expect(hotRepo({ taskId: "t1" }, tasks)).toBe("a");
    expect(hotRepo({ taskId: "gone" }, tasks)).toBeNull();
  });
});
