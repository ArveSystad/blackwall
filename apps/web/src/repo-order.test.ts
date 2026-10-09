import { describe, expect, it } from "vitest";
import { moveRepo, reorderRepoIds } from "./repo-order";

const repos = [
  { id: "f1", favorite: true },
  { id: "f2", favorite: true },
  { id: "a", favorite: false },
  { id: "b", favorite: false },
  { id: "c", favorite: false },
];

describe("reorderRepoIds", () => {
  it("moves a repo to the target's place within its group", () => {
    expect(reorderRepoIds(repos, "c", "a")).toEqual(["f1", "f2", "c", "a", "b"]);
    expect(reorderRepoIds(repos, "a", "c")).toEqual(["f1", "f2", "b", "c", "a"]);
    expect(reorderRepoIds(repos, "f2", "f1")).toEqual(["f2", "f1", "a", "b", "c"]);
  });

  it("refuses drops across groups, onto itself or for unknown repos", () => {
    expect(reorderRepoIds(repos, "a", "f2")).toBeNull();
    expect(reorderRepoIds(repos, "f1", "a")).toBeNull();
    expect(reorderRepoIds(repos, "a", "a")).toBeNull();
    expect(reorderRepoIds(repos, "x", "a")).toBeNull();
  });
});

describe("moveRepo", () => {
  it("moves one step within the group", () => {
    expect(moveRepo(repos, "b", -1)).toEqual(["f1", "f2", "b", "a", "c"]);
    expect(moveRepo(repos, "f1", 1)).toEqual(["f2", "f1", "a", "b", "c"]);
  });

  it("stops at the group's edges", () => {
    expect(moveRepo(repos, "a", -1)).toBeNull();
    expect(moveRepo(repos, "f2", 1)).toBeNull();
    expect(moveRepo(repos, "f1", -1)).toBeNull();
    expect(moveRepo(repos, "c", 1)).toBeNull();
  });
});
