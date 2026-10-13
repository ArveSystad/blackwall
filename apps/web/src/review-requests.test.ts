import type { ConnectionView, ReviewRequest } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import { issueOrigin } from "./assigned-issues";
import {
  groupByHost,
  hasGitHubConnection,
  prOrigin,
  pullRequestWork,
  reviewPillLabel,
  reviewStatusLabel,
} from "./review-requests";
import { makeBacklogItem, makeTask } from "./test-fixtures";

const pr = (host: string, number: number): ReviewRequest => ({
  host,
  owner: "acme",
  repo: "shop",
  number,
  title: `PR ${number}`,
  url: `https://${host}/acme/shop/pull/${number}`,
  author: "kari",
  updatedAt: new Date("2026-10-01T10:00:00Z"),
  reviewDecision: "review-required",
  repoId: "r1",
  connectionId: "c2",
});

const connection = (kind: ConnectionView["kind"], hasToken: boolean) =>
  ({ id: "c1", kind, hasToken }) as ConnectionView;

describe("reviewStatusLabel", () => {
  it("names each decision, and no decision as awaiting review", () => {
    expect(reviewStatusLabel("review-required")).toBe("Review required");
    expect(reviewStatusLabel("changes-requested")).toBe("Changes requested");
    expect(reviewStatusLabel(null)).toBe("Awaiting review");
  });
});

describe("groupByHost", () => {
  it("orders hosts by name and keeps the order within each host", () => {
    const groups = groupByHost([
      pr("github.com", 3),
      pr("acme.ghe.com", 1),
      pr("github.com", 2),
      pr("acme.ghe.com", 4),
    ]);
    expect(groups.map((g) => g.host)).toEqual(["acme.ghe.com", "github.com"]);
    expect(groups[0]!.rows.map((p) => p.number)).toEqual([1, 4]);
    expect(groups[1]!.rows.map((p) => p.number)).toEqual([3, 2]);
  });

  it("gives no groups for no PRs", () => {
    expect(groupByHost([])).toEqual([]);
  });
});

describe("reviewPillLabel", () => {
  it("counts in words", () => {
    expect(reviewPillLabel(0)).toBe("No pull requests need your review");
    expect(reviewPillLabel(1)).toBe("1 pull request needs your review");
    expect(reviewPillLabel(3)).toBe("3 pull requests need your review");
  });
});

describe("prOrigin", () => {
  it("builds the github-pr origin with the PR's connection", () => {
    expect(prOrigin(pr("acme.ghe.com", 42))).toEqual({
      kind: "github-pr",
      url: "https://acme.ghe.com/acme/shop/pull/42",
      owner: "acme",
      repo: "shop",
      number: 42,
      connectionId: "c2",
    });
  });
});

describe("pullRequestWork", () => {
  const review = pr("acme.ghe.com", 42);
  const origin = prOrigin(review);

  it("returns null when nothing works on the PR", () => {
    expect(pullRequestWork(review, [makeTask()], [makeBacklogItem()])).toBeNull();
  });

  it("finds a task for the PR, whatever its mode", () => {
    const task = makeTask({ origin, mode: "work" });
    expect(pullRequestWork(review, [makeTask(), task], [])).toEqual({
      kind: "task",
      taskId: task.id,
    });
  });

  it("ignores archived tasks", () => {
    const task = makeTask({
      origin,
      mode: "review",
      archivedAt: new Date("2026-10-09T10:00:00.000Z"),
    });
    expect(pullRequestWork(review, [task], [])).toBeNull();
  });

  it("finds a waiting backlog item", () => {
    const item = makeBacklogItem({ origin, mode: "review", status: "waiting", repoId: "r9" });
    expect(pullRequestWork(review, [], [item])).toEqual({ kind: "backlog", repoId: "r9" });
  });

  it("maps a promoted item to its task", () => {
    const item = makeBacklogItem({ origin, mode: "review", status: "promoted", taskId: "t42" });
    expect(pullRequestWork(review, [], [item])).toEqual({ kind: "task", taskId: "t42" });
  });

  it("does not match an issue with the same number", () => {
    const task = makeTask({
      origin: issueOrigin({ ...review, url: "https://acme.ghe.com/acme/shop/issues/42" }),
    });
    expect(pullRequestWork(review, [task], [])).toBeNull();
  });
});

describe("hasGitHubConnection", () => {
  it("needs a GitHub connection with a token", () => {
    expect(hasGitHubConnection([])).toBe(false);
    expect(hasGitHubConnection([connection("jira", true)])).toBe(false);
    expect(hasGitHubConnection([connection("github", false)])).toBe(false);
    expect(hasGitHubConnection([connection("jira", true), connection("github", true)])).toBe(true);
  });
});
