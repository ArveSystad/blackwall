import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchForTask, prBranchName, slugify, worktreePathFor } from "./branches.js";

describe("slugify", () => {
  it("lower-cases, hyphenates and strips accents", () => {
    expect(slugify("  Fix: Login fails (SSO)!  ")).toBe("fix-login-fails-sso");
    expect(slugify("Rød bil på Ærø")).toBe("rod-bil-pa-aero");
    expect(slugify("Café naïve")).toBe("cafe-naive");
  });

  it("cuts long titles at a word boundary", () => {
    expect(slugify("alpha beta gamma delta", 16)).toBe("alpha-beta-gamma");
    expect(slugify("alpha beta gamma delta", 15)).toBe("alpha-beta");
    expect(slugify("supercalifragilistic", 5)).toBe("super");
    expect(slugify("!!!")).toBe("");
  });
});

describe("branchForTask", () => {
  it("uses the PR head branch for PR tasks", () => {
    expect(branchForTask({ kind: "github-pr", headBranch: "feature/x" })).toBe("feature/x");
  });

  it("names Jira branches feature/ or fix/ by issue type", () => {
    const issue = { kind: "jira-issue", key: "ABC-123", title: "Short summary" } as const;
    expect(branchForTask({ ...issue, issueType: "Story" })).toBe("feature/abc-123-short-summary");
    expect(branchForTask({ ...issue, issueType: "Bug" })).toBe("fix/abc-123-short-summary");
    expect(branchForTask({ ...issue, issueType: " bug " })).toBe("fix/abc-123-short-summary");
    expect(branchForTask({ ...issue, title: "???", issueType: "Task" })).toBe("feature/abc-123");
  });

  it("names GitHub issue branches feature/ or fix/ by the bug label", () => {
    const issue = { kind: "github-issue", number: 7, title: "Export drops a row" } as const;
    expect(branchForTask({ ...issue, bug: false })).toBe("feature/7-export-drops-a-row");
    expect(branchForTask({ ...issue, bug: true })).toBe("fix/7-export-drops-a-row");
    expect(branchForTask({ ...issue, title: "!!!", bug: false })).toBe("feature/7");
  });

  it("uses agent/<task-id> for free-text tasks", () => {
    expect(branchForTask({ kind: "free-text", taskId: "t_42" })).toBe("agent/t_42");
  });
});

describe("prBranchName", () => {
  const task = { title: "Fix login", taskId: "0123456789abcdef" };

  it("names the branch feat/ or fix/", () => {
    expect(prBranchName({ ...task, bug: false })).toBe("feat/fix-login");
    expect(prBranchName({ ...task, bug: true })).toBe("fix/fix-login");
  });

  it("cuts the slug at 30 characters on a word boundary", () => {
    const title = "Show the weekly report totals per team member";
    expect(prBranchName({ ...task, title, bug: false })).toBe("feat/show-the-weekly-report-totals");
  });

  it("strips accents and Norwegian letters", () => {
    expect(prBranchName({ ...task, title: "Rød bil på Ærø, café", bug: false })).toBe(
      "feat/rod-bil-pa-aero-cafe",
    );
  });

  it("falls back to the task id when the title has no slug", () => {
    expect(prBranchName({ ...task, title: "!!!", bug: true })).toBe("fix/01234567");
  });
});

describe("worktreePathFor", () => {
  it("puts the worktree in a sibling <repo>.worktrees folder", () => {
    expect(worktreePathFor(join("code", "app"), "t1")).toBe(join("code", "app.worktrees", "t1"));
  });
});
