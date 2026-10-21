import type { AssignedIssue, RepoIssue, RepoJiraIssue } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  issueOrigin,
  issuePillLabel,
  issueWork,
  jiraIssueOrigin,
  jiraIssueWork,
} from "./assigned-issues";
import { queryKeys } from "./query";
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

  it("accepts a repo issue with its assignees", () => {
    const repoIssue: RepoIssue = { ...issue, assignees: ["ola"] };
    const task = makeTask({ origin: issueOrigin(repoIssue) });
    expect(issueWork(repoIssue, [task], [])).toEqual({ kind: "task", taskId: task.id });
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

const jiraIssue: RepoJiraIssue = {
  host: "acme.atlassian.net",
  key: "ABC-7",
  title: "Totals drift by a cent",
  url: "https://acme.atlassian.net/browse/ABC-7",
  issueType: "Bug",
  status: "To Do",
  author: "Kari",
  assignee: null,
  updatedAt: new Date("2026-10-08T10:00:00.000Z"),
  repoId: "r1",
  connectionId: "j1",
};
const jiraOrigin = jiraIssueOrigin(jiraIssue);

describe("jiraIssueOrigin", () => {
  it("builds the jira-issue origin with the issue's connection", () => {
    expect(jiraOrigin).toEqual({ kind: "jira-issue", key: "ABC-7", connectionId: "j1" });
  });
});

describe("jiraIssueWork", () => {
  it("returns null when nothing works on the issue", () => {
    expect(jiraIssueWork(jiraIssue, [makeTask()], [makeBacklogItem()])).toBeNull();
  });

  it("finds a task on the same key, with the same or no connection", () => {
    for (const connectionId of ["j1", null]) {
      const task = makeTask({ origin: { ...jiraOrigin, connectionId } });
      expect(jiraIssueWork(jiraIssue, [task], [])).toEqual({ kind: "task", taskId: task.id });
    }
  });

  it("ignores archived tasks, other keys and other connections", () => {
    const tasks = [
      makeTask({ origin: jiraOrigin, archivedAt: new Date("2026-10-09T10:00:00.000Z") }),
      makeTask({ origin: { ...jiraOrigin, key: "ABC-8" } }),
      makeTask({ origin: { ...jiraOrigin, connectionId: "j2" } }),
    ];
    expect(jiraIssueWork(jiraIssue, tasks, [])).toBeNull();
  });

  it("finds a waiting backlog item and maps a promoted one to its task", () => {
    const waiting = makeBacklogItem({ origin: jiraOrigin, status: "waiting", repoId: "r9" });
    expect(jiraIssueWork(jiraIssue, [], [waiting])).toEqual({ kind: "backlog", repoId: "r9" });
    const promoted = makeBacklogItem({ origin: jiraOrigin, status: "promoted", taskId: "t42" });
    expect(jiraIssueWork(jiraIssue, [], [promoted])).toEqual({ kind: "task", taskId: "t42" });
  });
});

describe("queryKeys.repoJiraIssues", () => {
  it("keys each project apart under the repo's shared prefix", () => {
    const abc = queryKeys.repoJiraIssues("r", "ABC");
    const def = queryKeys.repoJiraIssues("r", "DEF");
    expect(abc).not.toEqual(def);
    expect(abc.slice(0, 2)).toEqual(["repo-jira-issues", "r"]);
    expect(def.slice(0, 2)).toEqual(["repo-jira-issues", "r"]);
  });
});
