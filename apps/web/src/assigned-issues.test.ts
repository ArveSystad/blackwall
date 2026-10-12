import type { AssignedIssue } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { issueOrigin, issuePillLabel, issueWork } from "./assigned-issues";
import { makeBacklogItem, makeTask } from "./test-fixtures";

describe("issuePillLabel", () => {
  it("counts in words", () => {
    expect(issuePillLabel(0)).toBe("No issues assigned to you");
    expect(issuePillLabel(1)).toBe("1 issue assigned to you");
    expect(issuePillLabel(3)).toBe("3 issues assigned to you");
  });
});

const issue: AssignedIssue = {
  host: "acme.ghe.com",
  owner: "acme",
  repo: "shop",
  number: 7,
  title: "Totals drift by a cent",
  url: "https://acme.ghe.com/acme/shop/issues/7",
  author: "kari",
  updatedAt: new Date("2026-10-08T10:00:00.000Z"),
  repoId: "r1",
  connectionId: "c2",
};
const origin = issueOrigin(issue);

describe("issueOrigin", () => {
  it("builds the github-issue origin with the issue's connection", () => {
    expect(origin).toEqual({
      kind: "github-issue",
      url: "https://acme.ghe.com/acme/shop/issues/7",
      owner: "acme",
      repo: "shop",
      number: 7,
      connectionId: "c2",
    });
  });
});

describe("issueWork", () => {
  it("returns null when nothing works on the issue", () => {
    expect(issueWork(issue, [makeTask()], [makeBacklogItem()])).toBeNull();
  });

  it("finds a task for the issue", () => {
    const task = makeTask({ origin });
    expect(issueWork(issue, [makeTask(), task], [])).toEqual({ kind: "task", taskId: task.id });
  });

  it("ignores archived tasks", () => {
    const task = makeTask({ origin, archivedAt: new Date("2026-10-09T10:00:00.000Z") });
    expect(issueWork(issue, [task], [])).toBeNull();
  });

  it("finds a waiting or paused backlog item", () => {
    for (const status of ["waiting", "paused"] as const) {
      const item = makeBacklogItem({ origin, status, repoId: "r9" });
      expect(issueWork(issue, [], [item])).toEqual({ kind: "backlog", repoId: "r9" });
    }
  });

  it("maps a promoted item to its task", () => {
    const item = makeBacklogItem({ origin, status: "promoted", taskId: "t42" });
    expect(issueWork(issue, [], [item])).toEqual({ kind: "task", taskId: "t42" });
    const orphan = makeBacklogItem({ origin, status: "promoted", taskId: null });
    expect(issueWork(issue, [], [orphan])).toBeNull();
  });

  it("compares host, owner and repo case-insensitively", () => {
    const task = makeTask({
      origin: {
        ...origin,
        url: "https://ACME.ghe.com/Acme/Shop/issues/7",
        owner: "Acme",
        repo: "SHOP",
      },
    });
    expect(issueWork(issue, [task], [])).toEqual({ kind: "task", taskId: task.id });
  });

  it("does not match another number, repo or host", () => {
    const tasks = [
      makeTask({
        origin: { ...origin, number: 8, url: "https://acme.ghe.com/acme/shop/issues/8" },
      }),
      makeTask({ origin: { ...origin, repo: "other" } }),
      makeTask({ origin: { ...origin, url: "https://github.com/acme/shop/issues/7" } }),
    ];
    expect(issueWork(issue, tasks, [])).toBeNull();
  });
});
