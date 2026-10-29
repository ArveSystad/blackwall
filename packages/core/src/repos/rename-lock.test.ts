import { describe, expect, it, vi } from "vitest";
import { TaskStateError } from "../pipeline/engine.js";
import { RepoRenamingError, createRepoRenameLocks } from "./rename-lock.js";
import { RepoBusyError } from "./service.js";

describe("repo rename locks", () => {
  it("holds a repo until released", () => {
    const locks = createRepoRenameLocks();
    const release = locks.hold("a");
    expect(locks.isHeld("a")).toBe(true);
    expect(locks.isHeld("b")).toBe(false);
    release();
    expect(locks.isHeld("a")).toBe(false);
  });

  it("refuses a second hold on the same repo", () => {
    const locks = createRepoRenameLocks();
    locks.hold("a", "app");
    expect(() => locks.hold("a", "app")).toThrow(RepoBusyError);
    expect(() => locks.hold("a", "app")).toThrow("app is already being renamed");
    expect(() => locks.hold("b")).not.toThrow();
  });

  it("releases once and tells the listeners once", () => {
    const locks = createRepoRenameLocks();
    const listener = vi.fn();
    locks.onRelease(listener);
    const release = locks.hold("a");
    release();
    release();
    expect(listener).toHaveBeenCalledTimes(1);
    const again = locks.hold("a");
    expect(locks.isHeld("a")).toBe(true);
    release();
    expect(locks.isHeld("a")).toBe(true);
    again();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("asserts the repo is free only while it is held", () => {
    const locks = createRepoRenameLocks();
    expect(() => locks.assertFree("a")).not.toThrow();
    const release = locks.hold("a");
    expect(() => locks.assertFree("a")).toThrow(RepoRenamingError);
    expect(() => locks.assertFree("a")).toThrow(TaskStateError);
    release();
    expect(() => locks.assertFree("a")).not.toThrow();
  });

  it("counts a partial rename as renaming until it is cleared", () => {
    const locks = createRepoRenameLocks();
    const release = locks.hold("a");
    expect(locks.isRenaming("a")).toBe(true);
    locks.markPartial("a");
    release();
    expect(locks.isRenaming("a")).toBe(true);
    expect(locks.isHeld("a")).toBe(false);
    locks.clearPartial("a");
    expect(locks.isRenaming("a")).toBe(false);
  });
});
