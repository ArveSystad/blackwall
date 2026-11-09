import { describe, expect, it } from "vitest";
import { HOME_X, HORIZON_Y } from "./agent-dots";
import {
  CLUSTER_X,
  DENSITY,
  DONE_CAP,
  hotRepo,
  layoutSkyline,
  MAX_OVERLAP,
  MAX_W,
  MIN_H,
  MIN_VISIBLE,
  MIN_W,
  repoActivity,
  repoDoneCounts,
  SIGN_CLEAR,
  towerHeight,
  windowColumns,
  windowInset,
  windowSpan,
  type Tower,
} from "./skyline";
import { makeTask } from "./test-fixtures";

function repo(id: string, favorite = false) {
  return { id, name: `Repo ${id}`, favorite };
}

const none = new Map<string, number>();
const idle = new Map<string, { running: number; needs: number }>();

const TOL = 0.5;
const L = (t: Tower) => t.x - t.width / 2;
const R = (t: Tower) => t.x + t.width / 2;
const zoneL = (width: number) => width / 2 + SIGN_CLEAR;
const zoneR = (width: number) => HOME_X.max * width;

function repos(n: number) {
  return Array.from({ length: n }, (_, i) => repo(`r${i}`));
}

function towers(n: number, width: number) {
  return layoutSkyline(repos(n), none, idle, width, 800);
}

/** A mix of done counts and live tasks, so heights (and depth) and lit windows vary. */
function busy(n: number, width: number) {
  const list = repos(n);
  const counts = new Map(list.map((r, i) => [r.id, (i * 7) % 70]));
  const activity = new Map<string, { running: number; needs: number }>();
  list.forEach((r, i) => {
    if (i % 3 === 0) activity.set(r.id, { running: 1 + (i % 4), needs: i % 2 });
  });
  return layoutSkyline(list, counts, activity, width, 800);
}

describe("layoutSkyline", () => {
  it("returns no towers without repos", () => {
    expect(layoutSkyline([], none, idle, 1000, 800)).toEqual([]);
  });

  it("is stable across calls and keeps its order across pane widths", () => {
    expect(towers(12, 1000)).toEqual(towers(12, 1000));
    const order = towers(12, 1000).map((t) => t.repoId);
    expect(towers(12, 1440).map((t) => t.repoId)).toEqual(order);
    expect(towers(12, 600).map((t) => t.repoId)).toEqual(order);
  });

  it("returns the towers left to right", () => {
    const xs = towers(15, 1000).map((t) => t.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("keeps the others' order and widths when a repo is added", () => {
    // Widths only depend on each repo's own id while the cluster has room (no
    // shared shrink): 11 towers at their widest still fit the zone's density.
    expect(11 * MAX_W).toBeLessThan(DENSITY * (zoneR(1440) - zoneL(1440)));
    const ten = repos(10);
    const before = layoutSkyline(ten, none, idle, 1440, 800);
    const after = layoutSkyline([...ten, repo("extra")], none, idle, 1440, 800).filter(
      (t) => t.repoId !== "extra",
    );
    expect(after.map((t) => t.repoId)).toEqual(before.map((t) => t.repoId));
    expect(after.map((t) => t.width)).toEqual(before.map((t) => t.width));
  });

  it("shrinks every tower by one factor once the zone fills, keeping their proportions", () => {
    const shrunk = towers(60, 1000);
    // A single repo never shrinks, so it shows each repo's nominal width.
    const nominal = new Map(
      shrunk.map((t) => [
        t.repoId,
        layoutSkyline([repo(t.repoId)], none, idle, 1000, 800)[0]!.width,
      ]),
    );
    const sorted = [...shrunk].sort((a, b) => nominal.get(a.repoId)! - nominal.get(b.repoId)!);
    sorted.forEach((tower, i) => {
      expect(tower.width).toBeGreaterThanOrEqual(MIN_W);
      expect(tower.width).toBeLessThan(nominal.get(tower.repoId)!);
      if (i > 0) expect(tower.width).toBeGreaterThanOrEqual(sorted[i - 1]!.width);
    });
  });

  it("varies the widths and the window columns", () => {
    const widths = towers(10, 1440).map((t) => t.width);
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThanOrEqual(8);
    expect(new Set(widths.map(windowColumns))).toEqual(new Set([1, 2]));
  });

  it("spreads favourites through the cluster", () => {
    const list = repos(10).map((r, i) => ({ ...r, favorite: i < 5 }));
    const laid = layoutSkyline(list, none, idle, 1000, 800);
    expect(laid.slice(0, 5).every((t) => t.favorite)).toBe(false);
    const favourites = laid.filter((t) => t.favorite).map((t) => t.repoId);
    expect(favourites.sort()).toEqual(
      list
        .slice(0, 5)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("centres a single repo right of centre", () => {
    const [tower] = layoutSkyline([repo("a")], none, idle, 1000, 800);
    expect(tower?.x).toBeCloseTo(CLUSTER_X * 1000);
  });

  it("keeps the cluster right of centre, clear of the running sign", () => {
    const cases: [number, number][] = [
      [3, 1000],
      [15, 1000],
      [40, 1000],
      [15, 1440],
      [15, 400],
    ];
    for (const [n, width] of cases) {
      for (const tower of towers(n, width)) {
        expect(L(tower)).toBeGreaterThanOrEqual(zoneL(width) - TOL);
        expect(R(tower)).toBeLessThanOrEqual(zoneR(width) + TOL);
      }
    }
  });

  it("slides left past the centre only when the cluster is wider than the zone", () => {
    // The MIN_W floor forces this: 120 · 4 = 480 > 404 and 60 · 4 = 240 > 152.
    const cases: [number, number][] = [
      [120, 1000],
      [60, 400],
    ];
    for (const [n, width] of cases) {
      const laid = towers(n, width);
      const left = Math.min(...laid.map(L));
      const right = Math.max(...laid.map(R));
      expect(right - left).toBeGreaterThan(zoneR(width) - zoneL(width));
      expect(left).toBeLessThan(zoneL(width));
      expect(right).toBeLessThanOrEqual(zoneR(width) + TOL);
    }
  });

  it("keeps every tower inside the dots' band", () => {
    const cases: [number, number][] = [
      [1, 1000],
      [2, 1000],
      [3, 1000],
      [15, 1000],
      [40, 1000],
      [120, 1000],
      [200, 400],
    ];
    for (const [n, width] of cases) {
      for (const tower of towers(n, width)) {
        expect(L(tower)).toBeGreaterThanOrEqual(HOME_X.min * width - TOL);
        expect(R(tower)).toBeLessThanOrEqual(HOME_X.max * width + TOL);
      }
    }
  });

  it("overlaps neighbours only across their plain walls, with now and then a gap", () => {
    const cases: [number, number][] = [
      [15, 1000],
      [40, 1000],
      [15, 1440],
    ];
    for (const [n, width] of cases) {
      const laid = towers(n, width);
      for (let i = 1; i < laid.length; i++) {
        const a = laid[i - 1]!;
        const b = laid[i]!;
        const narrow = Math.min(a.width, b.width);
        const overlap = R(a) - L(b);
        const cap = Math.min(MAX_OVERLAP * narrow, windowInset(a.width), windowInset(b.width));
        expect(overlap).toBeLessThanOrEqual(cap + 1e-6);
        expect(overlap).toBeGreaterThanOrEqual(-0.4 * narrow - 1e-6);
      }
    }
    const wide = towers(15, 1440);
    expect(wide.some((t, i) => i > 0 && R(wide[i - 1]!) - L(t) > 0)).toBe(true);
  });

  it("never covers a window, and every tower shows some face", () => {
    const cases: [number, number][] = [
      [2, 1000],
      [3, 1000],
      [15, 1000],
      [40, 1000],
      [15, 1440],
    ];
    for (const [n, width] of cases) {
      const laid = busy(n, width);
      expect(laid.some((t) => t.windows.some((w) => w !== "off"))).toBe(true);
      laid.forEach((tower, i) => {
        const half = windowSpan(windowColumns(tower.width)) / 2;
        const prev = laid[i - 1];
        const next = laid[i + 1];
        if (prev) expect(R(prev)).toBeLessThanOrEqual(tower.x - half + 0.01);
        if (next) expect(L(next)).toBeGreaterThanOrEqual(tower.x + half - 0.01);
        const face =
          Math.min(R(tower), next ? L(next) : Infinity) -
          Math.max(L(tower), prev ? R(prev) : -Infinity);
        expect(face).toBeGreaterThanOrEqual(MIN_VISIBLE - 0.01);
      });
    }
  });

  it("matches the rendered window offsets", () => {
    expect(windowSpan(1)).toBe(3);
    expect(windowSpan(2)).toBe(10);
  });

  it("stands shorter towers in front", () => {
    const laid = busy(15, 1000);
    expect(laid.map((t) => t.z).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 1),
    );
    for (const a of laid) {
      for (const b of laid) {
        if (a.height < b.height) expect(a.z).toBeGreaterThan(b.z);
      }
    }
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

  it("keeps widths between 4 and 24px and splits windows into two columns from 14px", () => {
    const cases: [number, number][] = [
      [10, 1440],
      [40, 1000],
      [200, 400],
    ];
    for (const [n, width] of cases) {
      for (const tower of busy(n, width)) {
        expect(tower.width).toBeGreaterThanOrEqual(MIN_W);
        expect(tower.width).toBeLessThanOrEqual(MAX_W);
        expect(tower.windows.length % windowColumns(tower.width)).toBe(0);
      }
    }
    expect(towers(200, 400).every((t) => t.width === MIN_W)).toBe(true);
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
    // No done tasks: MIN_H tall, one row of windows.
    expect(tower?.windows.length).toBe(windowColumns(tower!.width));
    expect(tower?.windows.every((w) => w === "needs-you")).toBe(true);
    expect(tower?.running).toBe(50);
    expect(tower?.needs).toBe(50);
  });

  it("passes the favourite flag and the done count through", () => {
    const laid = layoutSkyline([repo("a", true), repo("b")], new Map([["a", 7]]), idle, 1000, 800);
    const fav = laid.find((t) => t.repoId === "a");
    const plain = laid.find((t) => t.repoId === "b");
    expect(fav?.favorite).toBe(true);
    expect(fav?.doneCount).toBe(7);
    expect(plain?.favorite).toBe(false);
    expect(plain?.doneCount).toBe(0);
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
    expect(towerHeight(DONE_CAP, 800)).toBe(towerHeight(DONE_CAP + 100, 800));
  });

  it("grows on a log curve", () => {
    const h = (n: number) => towerHeight(n, 800);
    expect(h(4) - h(0)).toBeGreaterThan(h(64) - h(60));
  });

  it("shrinks the cap on short panes, never below MIN_H", () => {
    expect(towerHeight(DONE_CAP, 2000)).toBe(120);
    expect(towerHeight(DONE_CAP, 300)).toBeCloseTo(54);
    expect(towerHeight(DONE_CAP, 20)).toBe(MIN_H);
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

describe("repoDoneCounts", () => {
  it("counts done tasks per repo, archived included, skipping other statuses", () => {
    const tasks = [
      makeTask({ repoId: "a", status: "done" }),
      makeTask({ repoId: "a", status: "done", archivedAt: new Date() }),
      makeTask({ repoId: "b", status: "done" }),
      makeTask({ repoId: "a", status: "running" }),
      makeTask({ repoId: "a", status: "needs-you" }),
      makeTask({ repoId: "c", status: "failed" }),
      makeTask({ repoId: "c", status: "queued" }),
    ];
    const counts = repoDoneCounts(tasks);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.has("c")).toBe(false);
    const c = layoutSkyline([repo("a"), repo("b"), repo("c")], counts, idle, 1000, 800).find(
      (t) => t.repoId === "c",
    );
    expect(c?.doneCount).toBe(0);
    expect(c?.height).toBe(MIN_H);
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
