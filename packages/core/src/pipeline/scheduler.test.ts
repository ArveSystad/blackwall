import { describe, expect, it } from "vitest";
import { createScheduler } from "./scheduler.js";

describe("scheduler", () => {
  it("runs at most the per-repo cap per repo, independently across repos", () => {
    let cap = 2;
    const s = createScheduler({ maxPerRepo: () => cap });
    for (const id of ["a1", "a2", "a3"]) s.enqueue({ id, repoId: "a", branch: null });
    s.enqueue({ id: "b1", repoId: "b", branch: null });

    expect(s.take().map((t) => t.id)).toEqual(["a1", "a2", "b1"]);
    expect(s.queuedIds()).toEqual(["a3"]);
    expect(s.take()).toEqual([]);

    s.release("a1");
    expect(s.take().map((t) => t.id)).toEqual(["a3"]);

    // A raised cap applies on the next pick.
    s.enqueue({ id: "a4", repoId: "a", branch: null });
    cap = 3;
    expect(s.take().map((t) => t.id)).toEqual(["a4"]);
  });

  it("keeps a held repo's tasks queued in order until it is free", () => {
    const heldRepos = new Set(["a"]);
    const s = createScheduler({ maxPerRepo: () => 3, held: (repoId) => heldRepos.has(repoId) });
    s.enqueue({ id: "a1", repoId: "a", branch: null });
    s.enqueue({ id: "b1", repoId: "b", branch: null });
    s.enqueue({ id: "a2", repoId: "a", branch: null });

    expect(s.take().map((t) => t.id)).toEqual(["b1"]);
    expect(s.queuedIds()).toEqual(["a1", "a2"]);
    heldRepos.clear();
    expect(s.take().map((t) => t.id)).toEqual(["a1", "a2"]);
  });

  it("runs one task per branch without blocking other branches behind it", () => {
    const s = createScheduler({ maxPerRepo: () => 3 });
    s.enqueue({ id: "t1", repoId: "r", branch: "feature/x" });
    s.enqueue({ id: "t2", repoId: "r", branch: "feature/x" });
    s.enqueue({ id: "t3", repoId: "r", branch: "feature/y" });
    s.enqueue({ id: "t4", repoId: "other", branch: "feature/x" });

    expect(s.take().map((t) => t.id)).toEqual(["t1", "t3", "t4"]);
    expect(s.queuedIds()).toEqual(["t2"]);
    s.release("t1");
    expect(s.take().map((t) => t.id)).toEqual(["t2"]);
  });

  it("holds a branch learned after start", () => {
    const s = createScheduler({ maxPerRepo: () => 3 });
    s.enqueue({ id: "t1", repoId: "r", branch: null });
    s.take();
    s.setBranch("t1", "agent/t1");
    s.enqueue({ id: "t2", repoId: "r", branch: "agent/t1" });
    expect(s.take()).toEqual([]);
  });

  it("keeps a re-queued running task waiting until it is released", () => {
    const s = createScheduler({ maxPerRepo: () => 3 });
    s.enqueue({ id: "t1", repoId: "r", branch: null });
    s.take();
    s.enqueue({ id: "t1", repoId: "r", branch: null });
    s.enqueue({ id: "t1", repoId: "r", branch: null });
    expect(s.take()).toEqual([]);
    expect(s.queuedIds()).toEqual(["t1"]);
    s.release("t1");
    expect(s.take().map((t) => t.id)).toEqual(["t1"]);
    expect(s.isActive("t1")).toBe(true);
  });
});
