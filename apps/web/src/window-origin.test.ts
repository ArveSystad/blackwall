import { describe, expect, it } from "vitest";
import {
  backlogRepoIdOf,
  isTaskPath,
  recordWindowOrigin,
  windowExitTarget,
  windowOriginFor,
  windowOriginOf,
  windowOriginOfPath,
} from "./window-origin";

const at = (pathname: string, key: string) => ({ pathname, state: { __TSR_key: key } });
const backlog = { to: "/repos/$repoId/backlog", params: { repoId: "abc" } } as const;

describe("backlogRepoIdOf", () => {
  it("is the repo id of a Backlog path", () => {
    expect(backlogRepoIdOf("/repos/abc/backlog")).toBe("abc");
    expect(backlogRepoIdOf("/repos/a%20b/backlog")).toBe("a b");
  });

  it("is null for other paths", () => {
    expect(backlogRepoIdOf("/")).toBeNull();
    expect(backlogRepoIdOf("/tasks/x")).toBeNull();
    expect(backlogRepoIdOf("/repos/abc/backlog/extra")).toBeNull();
  });
});

describe("isTaskPath", () => {
  it("matches task paths only", () => {
    expect(isTaskPath("/tasks/x")).toBe(true);
    expect(isTaskPath("/")).toBe(false);
    expect(isTaskPath("/repos/abc/backlog")).toBe(false);
  });
});

describe("windowOriginOfPath", () => {
  it("is the exit back to a list window", () => {
    expect(windowOriginOfPath("/reviews")).toEqual({ to: "/reviews" });
    expect(windowOriginOfPath("/issues")).toEqual({ to: "/issues" });
    expect(windowOriginOfPath("/pulls")).toEqual({ to: "/pulls" });
    expect(windowOriginOfPath("/active")).toEqual({ to: "/active" });
  });

  it("is the exit back to a Backlog", () => {
    expect(windowOriginOfPath("/repos/abc/backlog")).toEqual(backlog);
  });

  it("is null for other paths", () => {
    expect(windowOriginOfPath("/")).toBeNull();
    expect(windowOriginOfPath("/tasks/y")).toBeNull();
    expect(windowOriginOfPath("/repos/x/code")).toBeNull();
    expect(windowOriginOfPath("/stats")).toBeNull();
    expect(windowOriginOfPath("/pulls/extra")).toBeNull();
  });
});

describe("windowExitTarget", () => {
  it("leaves a Backlog for the grid", () => {
    expect(windowExitTarget("/repos/abc/backlog", backlog)).toEqual({ to: "/" });
  });

  it("leaves a list for the grid", () => {
    expect(windowExitTarget("/reviews", null)).toEqual({ to: "/" });
  });

  it("leaves a task for the Backlog it came from", () => {
    expect(windowExitTarget("/tasks/x", backlog)).toEqual(backlog);
  });

  it("leaves a task for the list it came from", () => {
    expect(windowExitTarget("/tasks/x", { to: "/issues" })).toEqual({ to: "/issues" });
  });

  it("leaves a task with no origin for the grid", () => {
    expect(windowExitTarget("/tasks/x", null)).toEqual({ to: "/" });
  });
});

describe("recordWindowOrigin", () => {
  it("records the Backlog a task was opened from", () => {
    recordWindowOrigin("/repos/abc/backlog", at("/tasks/x", "k1"));
    expect(windowOriginFor("k1")).toEqual(backlog);
    expect(windowOriginOf(at("/tasks/x", "k1"))).toEqual(backlog);
  });

  it("records the list a task was opened from", () => {
    recordWindowOrigin("/reviews", at("/tasks/x", "k9"));
    recordWindowOrigin("/issues", at("/tasks/x", "k10"));
    recordWindowOrigin("/pulls", at("/tasks/x", "k11"));
    recordWindowOrigin("/active", at("/tasks/x", "k12"));
    expect(windowOriginFor("k9")).toEqual({ to: "/reviews" });
    expect(windowOriginFor("k10")).toEqual({ to: "/issues" });
    expect(windowOriginFor("k11")).toEqual({ to: "/pulls" });
    expect(windowOriginFor("k12")).toEqual({ to: "/active" });
  });

  it("records no origin from the grid, another task or a first load", () => {
    recordWindowOrigin("/", at("/tasks/x", "k2"));
    recordWindowOrigin("/tasks/y", at("/tasks/x", "k3"));
    recordWindowOrigin(undefined, at("/tasks/x", "k4"));
    expect(windowOriginFor("k2")).toBeNull();
    expect(windowOriginFor("k3")).toBeNull();
    expect(windowOriginFor("k4")).toBeNull();
  });

  it("keeps an entry's origin when it resolves again", () => {
    recordWindowOrigin("/repos/abc/backlog", at("/tasks/x", "k5"));
    recordWindowOrigin("/", at("/tasks/x", "k5"));
    expect(windowOriginFor("k5")).toEqual(backlog);
  });

  it("ignores locations that are not tasks", () => {
    recordWindowOrigin("/repos/abc/backlog", at("/", "k6"));
    recordWindowOrigin("/repos/abc/backlog", at("/repos/def/backlog", "k7"));
    expect(windowOriginFor("k6")).toBeNull();
    expect(windowOriginFor("k7")).toBeNull();
  });

  it("falls back to the plain history key", () => {
    recordWindowOrigin("/repos/abc/backlog", { pathname: "/tasks/x", state: { key: "k8" } });
    expect(windowOriginFor("k8")).toEqual(backlog);
  });

  it("knows no origin without a key", () => {
    expect(windowOriginFor(undefined)).toBeNull();
    expect(windowOriginFor("missing")).toBeNull();
  });
});
