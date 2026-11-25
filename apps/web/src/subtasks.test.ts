import { describe, expect, it } from "vitest";
import {
  childrenOf,
  deleteSubtasksNote,
  isSplitParent,
  nestSubtasks,
  parentOf,
  subtaskProgress,
} from "./subtasks";
import { makeTask } from "./test-fixtures";

const subtasks = [{ repoId: "r2", title: "Change api", description: "Do it" }];

describe("subtasks", () => {
  const parent = makeTask({ status: "waiting", subtasks });
  const a = makeTask({ parentTaskId: parent.id, status: "done" });
  const b = makeTask({ parentTaskId: parent.id, status: "running" });
  const other = makeTask();
  const tasks = [parent, a, other, b];

  it("finds a parent's children and a child's parent", () => {
    expect(childrenOf(tasks, parent.id)).toEqual([a, b]);
    expect(parentOf(tasks, a)).toBe(parent);
    expect(parentOf(tasks, other)).toBeUndefined();
    expect(parentOf([a], a)).toBeUndefined();
  });

  it("counts the done subtasks", () => {
    expect(subtaskProgress(tasks, parent.id)).toEqual({ done: 1, total: 2 });
    expect(subtaskProgress(tasks, other.id)).toBeUndefined();
  });

  it("tells a split parent from a task whose plan proposes subtasks", () => {
    expect(isSplitParent(parent)).toBe(true);
    expect(isSplitParent(makeTask({ status: "needs-you", gate: "finish", subtasks }))).toBe(true);
    expect(isSplitParent(makeTask({ status: "done", subtasks }))).toBe(true);
    expect(isSplitParent(makeTask({ status: "needs-you", gate: "plan-approval", subtasks }))).toBe(
      false,
    );
    expect(isSplitParent(makeTask({ status: "running", subtasks }))).toBe(false);
    expect(isSplitParent(makeTask({ status: "done" }))).toBe(false);
  });
});

describe("nestSubtasks", () => {
  it("moves subtasks under their parent when it is listed", () => {
    const parent = makeTask();
    const child = makeTask({ parentTaskId: parent.id });
    const orphan = makeTask({ parentTaskId: "gone" });
    const other = makeTask();
    expect(nestSubtasks([child, other, parent, orphan])).toEqual([other, parent, child, orphan]);
  });
});

describe("deleteSubtasksNote", () => {
  it("says what happens to the subtasks or the parent", () => {
    const parent = makeTask({ status: "waiting" });
    const a = makeTask({ parentTaskId: parent.id });
    const b = makeTask({ parentTaskId: parent.id });
    expect(deleteSubtasksNote([parent, a, b], parent)).toBe(
      "Its 2 subtasks keep running as standalone tasks.",
    );
    expect(deleteSubtasksNote([parent, a, b], a)).toBeNull();
    expect(deleteSubtasksNote([parent, a], a)).toBe("The parent task goes back to plan approval.");
    expect(deleteSubtasksNote([a], a)).toBeNull();
  });
});
