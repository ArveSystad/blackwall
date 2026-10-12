import type { ConnectionView, ReviewRequest } from "@blackwall/shared";
import { describe, expect, it } from "vitest";
import {
  groupByHost,
  hasGitHubConnection,
  reviewPillLabel,
  reviewStatusLabel,
} from "./review-requests";

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

describe("hasGitHubConnection", () => {
  it("needs a GitHub connection with a token", () => {
    expect(hasGitHubConnection([])).toBe(false);
    expect(hasGitHubConnection([connection("jira", true)])).toBe(false);
    expect(hasGitHubConnection([connection("github", false)])).toBe(false);
    expect(hasGitHubConnection([connection("jira", true), connection("github", true)])).toBe(true);
  });
});
