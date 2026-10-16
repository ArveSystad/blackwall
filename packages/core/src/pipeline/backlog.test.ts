import { describe, expect, it } from "vitest";
import {
  createsDependencyCycle,
  nextBacklogItem,
  sortBacklog,
  unmetDependencies,
  type BacklogPickItem,
} from "./backlog.js";

let clock = 0;
function item(id: string, patch: Partial<BacklogPickItem> = {}): BacklogPickItem {
  return {
    id,
    position: 0,
    createdAt: new Date(++clock),
    status: "waiting",
    dependsOn: [],
    taskId: null,
    ...patch,
  };
}

const none = () => false;
const pick = (items: BacklogPickItem[], isDone: (taskId: string) => boolean = none) =>
  nextBacklogItem(items, isDone)?.id;

describe("nextBacklogItem", () => {
  it("returns undefined for an empty backlog", () => {
    expect(pick([])).toBeUndefined();
  });

  it("orders by position, then age", () => {
    const items = [
      item("late", { position: 2 }),
      item("early", { position: 1 }),
      item("early-newer", { position: 1 }),
      item("first", { position: 0 }),
    ];
    expect(sortBacklog(items).map((i) => i.id)).toEqual(["first", "early", "early-newer", "late"]);
    expect(pick(items)).toBe("first");
  });

  it("skips paused and promoted items", () => {
    const items = [
      item("paused", { status: "paused" }),
      item("promoted", { status: "promoted", taskId: "t1" }),
      item("waiting", { position: 1 }),
    ];
    expect(pick(items)).toBe("waiting");
    expect(pick([item("p", { status: "paused" })])).toBeUndefined();
  });

  it("descends into unmet dependencies in listed order", () => {
    const items = [
      item("head", { dependsOn: ["dep1", "dep2"] }),
      item("dep1", { position: 2, dependsOn: ["deep"] }),
      item("dep2", { position: 2 }),
      item("deep", { position: 5 }),
      item("other", { position: 1 }),
    ];
    expect(pick(items)).toBe("deep");
  });

  it("tries the next dependency when one is held back", () => {
    const items = [
      item("head", { dependsOn: ["paused", "ready"] }),
      item("paused", { status: "paused" }),
      item("ready", { position: 1 }),
    ];
    expect(pick(items)).toBe("ready");
  });

  it("treats a dependency as done only when its promoted task is done", () => {
    const dep = item("dep", { status: "promoted", taskId: "t1" });
    const head = item("head", { dependsOn: ["dep"] });
    const later = item("later", { position: 1 });
    // Running (or failed) task: head is blocked, and the in-flight dependency is not picked.
    expect(pick([dep, head, later])).toBe("later");
    expect(pick([dep, head, later], (id) => id === "t1")).toBe("head");
    // The promoted task was deleted: the link is gone, still blocked.
    expect(pick([{ ...dep, taskId: null }, head])).toBeUndefined();
  });

  it("blocks an item whose dependency no longer exists", () => {
    const items = [item("head", { dependsOn: ["gone"] }), item("next", { position: 1 })];
    expect(pick(items)).toBe("next");
    expect(pick([items[0]!])).toBeUndefined();
    expect(unmetDependencies(items[0]!, new Map(), none)).toEqual(["gone"]);
  });

  it("does not loop on dependency cycles", () => {
    const items = [
      item("a", { dependsOn: ["b"] }),
      item("b", { dependsOn: ["c"] }),
      item("c", { dependsOn: ["a"] }),
    ];
    expect(pick(items)).toBeUndefined();
    expect(pick([...items, item("free", { position: 1 })])).toBe("free");
    expect(pick([item("self", { dependsOn: ["self"] })])).toBeUndefined();
  });
});

describe("createsDependencyCycle", () => {
  const items = [
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["c"] },
    { id: "c", dependsOn: [] },
  ];

  it("detects direct, indirect and self cycles", () => {
    expect(createsDependencyCycle(items, "c", ["a"])).toBe(true);
    expect(createsDependencyCycle(items, "b", ["a"])).toBe(true);
    expect(createsDependencyCycle(items, "a", ["a"])).toBe(true);
  });

  it("allows acyclic edits and unknown ids", () => {
    expect(createsDependencyCycle(items, "a", ["c"])).toBe(false);
    expect(createsDependencyCycle(items, "c", ["gone"])).toBe(false);
    expect(createsDependencyCycle(items, "new", ["a"])).toBe(false);
  });
});
