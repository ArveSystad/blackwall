import { describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "./client.js";
import {
  findPullRequestStack,
  renderPullRequestStack,
  type PullRequestStackMember,
} from "./stack.js";

const GHE = { baseUrl: "https://acme.ghe.com", token: "ghp_secret_token" };

interface FakePr {
  number: number;
  head: string;
  base: string;
  /** Head repository; defaults to acme/shop. */
  headRepo?: string;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Serves `prs` as acme/shop's open PRs, filtering lists by `head` and `base` like GitHub. */
function fakeGitHub(prs: FakePr[]) {
  const toJson = (pr: FakePr) => ({
    number: pr.number,
    html_url: `https://acme.ghe.com/acme/shop/pull/${pr.number}`,
    title: `PR ${pr.number}`,
    state: "open",
    head: { ref: pr.head, sha: "a", repo: { full_name: pr.headRepo ?? "acme/shop" } },
    base: { ref: pr.base, sha: "b", repo: { full_name: "acme/shop", default_branch: "main" } },
  });
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(String(input));
    const one = /^\/repos\/acme\/shop\/pulls\/(\d+)$/.exec(url.pathname);
    if (one) {
      const pr = prs.find((p) => p.number === Number(one[1]));
      return Promise.resolve(pr ? json(toJson(pr)) : json({ message: "Not Found" }));
    }
    if (url.pathname === "/repos/acme/shop/pulls") {
      const head = url.searchParams.get("head");
      const base = url.searchParams.get("base");
      return Promise.resolve(
        json(
          prs
            .filter(
              (p) =>
                (head === null ||
                  head === `${(p.headRepo ?? "acme/shop").split("/")[0]}:${p.head}`) &&
                (base === null || base === p.base),
            )
            .map(toJson),
        ),
      );
    }
    return Promise.resolve(json({ message: "Not Found" }));
  });
}

const STACK: FakePr[] = [
  { number: 41, head: "b41", base: "main" },
  { number: 42, head: "b42", base: "b41" },
  { number: 43, head: "b43", base: "b42" },
  { number: 50, head: "other", base: "main" },
];

async function stackOf(prs: FakePr[], number: number) {
  const fetchImpl = fakeGitHub(prs);
  const client = createGitHubClient(GHE, fetchImpl);
  const members = await findPullRequestStack(client, { owner: "acme", repo: "shop", number });
  const lists = fetchImpl.mock.calls
    .map(([input]) => new URL(String(input)))
    .filter((url) => url.pathname === "/repos/acme/shop/pulls")
    .map((url) => url.search);
  return { numbers: members.map((m) => m.number), members, lists };
}

describe("findPullRequestStack", () => {
  it("returns the stack bottom first from any of its PRs", async () => {
    for (const number of [41, 42, 43]) {
      expect((await stackOf(STACK, number)).numbers).toEqual([41, 42, 43]);
    }
    expect((await stackOf(STACK, 42)).members[1]).toEqual({
      number: 42,
      title: "PR 42",
      url: "https://acme.ghe.com/acme/shop/pull/42",
      headRef: "b42",
      baseRef: "b41",
    });
  });

  it("returns a PR that is not stacked alone, without looking below the default branch", async () => {
    const { numbers, lists } = await stackOf(STACK, 50);
    expect(numbers).toEqual([50]);
    expect(lists.some((search) => search.includes("head="))).toBe(false);
  });

  it("stops at a fork in the tree", async () => {
    const forked = [...STACK, { number: 44, head: "b44", base: "b42" }];
    expect((await stackOf(forked, 41)).numbers).toEqual([41, 42]);
    expect((await stackOf(forked, 43)).numbers).toEqual([41, 42, 43]);
  });

  it("stops on a branch cycle", async () => {
    const cycle = [
      { number: 1, head: "x", base: "y" },
      { number: 2, head: "y", base: "x" },
    ];
    expect((await stackOf(cycle, 1)).numbers).toEqual([2, 1]);
  });

  it("ignores PRs from forks", async () => {
    const withFork = [...STACK, { number: 60, head: "b43", base: "b42", headRepo: "someone/shop" }];
    expect((await stackOf(withFork, 42)).numbers).toEqual([41, 42, 43]);
    const fromFork = [{ number: 61, head: "b41", base: "main", headRepo: "someone/shop" }];
    expect((await stackOf([...STACK, ...fromFork], 61)).numbers).toEqual([61]);
  });
});

describe("renderPullRequestStack", () => {
  const member = (number: number, headRef: string, baseRef: string): PullRequestStackMember => ({
    number,
    title: `PR ${number}`,
    url: `https://acme.ghe.com/acme/shop/pull/${number}`,
    headRef,
    baseRef,
  });
  const members = [member(41, "b41", "main"), member(42, "b42", "b41"), member(43, "b43", "b42")];

  it("lists the stack, labels the other PRs and leaves out this PR's diff", () => {
    const text = renderPullRequestStack(
      members,
      42,
      new Map([
        [41, "diff --git a/below b/below\n"],
        [42, "diff --git a/mine b/mine\n"],
        [43, "diff --git a/above b/above\n"],
      ]),
    );
    expect(text).toContain("2. #42: PR 42 (b42 → b41) ← this PR");
    expect(text).toContain("### #41: PR 41 (b41 → main), below this PR");
    expect(text).toContain("### #43: PR 43 (b43 → b42), above this PR");
    expect(text).toContain("a/below");
    expect(text).toContain("a/above");
    expect(text).not.toContain("a/mine");
    expect(text).not.toContain("### #42");
    expect(text).toContain("Report findings only on this pull request's own changes");
  });

  it("shares the diff budget, cutting with a note", () => {
    const text = renderPullRequestStack(
      members,
      41,
      new Map([
        [42, "a".repeat(8)],
        [43, "b".repeat(8)],
      ]),
      { maxDiffChars: 10 },
    );
    expect(text).toContain("a".repeat(8));
    expect(text).toContain("bb\n");
    expect(text).not.toContain("bbb");
    expect(text).toContain("The diff is cut at 2 of 8 characters.");
  });
});
