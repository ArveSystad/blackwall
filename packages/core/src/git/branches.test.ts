import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { branchForTask, slugify, worktreePathFor } from "./branches.js";

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

  it("uses agent/<task-id> for free-text tasks", () => {
    expect(branchForTask({ kind: "free-text", taskId: "t_42" })).toBe("agent/t_42");
  });
});

describe("worktreePathFor", () => {
  it("puts the worktree in a sibling <repo>.worktrees folder", () => {
    expect(worktreePathFor(join("code", "app"), "t1")).toBe(join("code", "app.worktrees", "t1"));
  });
});
