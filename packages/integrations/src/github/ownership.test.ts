import { describe, expect, it } from "vitest";
import { pullRequestOwnedBy } from "./ownership.js";

const own = {
  authorLogin: "arve",
  headRepo: "acme/shop",
  baseRepo: "acme/shop",
};
const mine = [{ authorLogin: "arve" }, { authorLogin: "arve" }];

describe("pullRequestOwnedBy", () => {
  it("is true for a PR the user opened from the base repo with only their own commits", () => {
    expect(pullRequestOwnedBy(own, mine, "arve")).toBe(true);
  });

  it("is false for a PR from a fork", () => {
    expect(pullRequestOwnedBy({ ...own, headRepo: "arve/shop" }, mine, "arve")).toBe(false);
  });

  it("is false when the head repository was deleted", () => {
    expect(pullRequestOwnedBy({ ...own, headRepo: null }, mine, "arve")).toBe(false);
  });

  it("is false for a PR another user opened", () => {
    expect(pullRequestOwnedBy({ ...own, authorLogin: "kari" }, mine, "arve")).toBe(false);
  });

  it("is false when the PR author is no longer a GitHub user", () => {
    expect(pullRequestOwnedBy({ ...own, authorLogin: null }, mine, "arve")).toBe(false);
  });

  it("is false when one commit is by someone else", () => {
    const commits = [...mine, { authorLogin: "kari" }];
    expect(pullRequestOwnedBy(own, commits, "arve")).toBe(false);
  });

  it("is false when one commit's author email is not linked to a GitHub user", () => {
    const commits = [...mine, { authorLogin: null }];
    expect(pullRequestOwnedBy(own, commits, "arve")).toBe(false);
  });

  it("is false without commits", () => {
    expect(pullRequestOwnedBy(own, [], "arve")).toBe(false);
  });

  it("compares logins and repositories case-insensitively", () => {
    const pr = { authorLogin: "Arve", headRepo: "Acme/Shop", baseRepo: "acme/shop" };
    expect(pullRequestOwnedBy(pr, [{ authorLogin: "ARVE" }], "arve")).toBe(true);
    expect(pullRequestOwnedBy(own, mine, "Arve")).toBe(true);
  });
});
