import type { GitHubClient, GitHubPullRequestJson, PullRequestCoordinates } from "./client.js";
import { fence } from "./markdown.js";
import { MAX_PROMPT_DIFF_CHARS } from "./pull-request.js";

/** One pull request of a stack, as {@link findPullRequestStack} returns it. */
export interface PullRequestStackMember {
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
}

/** A stack never grows past this many PRs, so a strange repository cannot loop for long. */
const MAX_STACK_SIZE = 20;

const member = (pr: GitHubPullRequestJson): PullRequestStackMember => ({
  number: pr.number,
  title: pr.title,
  url: pr.html_url,
  headRef: pr.head.ref,
  baseRef: pr.base.ref,
});

/**
 * The linear stack the pull request belongs to, bottom first: walking down
 * while its base branch is the head branch of exactly one open PR (stopping
 * at the repository's default branch), then up while exactly one open PR
 * targets the top's head branch. A fork in the tree, a branch already seen
 * and PRs from forks end the walk. A PR that is not stacked comes back alone.
 */
export async function findPullRequestStack(
  client: Pick<GitHubClient, "getPullRequest" | "listOpenPullRequests">,
  pr: PullRequestCoordinates,
  signal?: AbortSignal,
): Promise<PullRequestStackMember[]> {
  const { owner, repo } = pr;
  const slug = `${owner}/${repo}`.toLowerCase();
  const sameRepo = (json: GitHubPullRequestJson) =>
    json.head.repo?.full_name.toLowerCase() === slug;

  const start = await client.getPullRequest(pr, signal);
  const stack = [start];
  if (!sameRepo(start)) return stack.map(member);
  const seen = new Set([start.head.ref]);

  let bottom = start;
  while (stack.length < MAX_STACK_SIZE) {
    const base = bottom.base.ref;
    if (base === bottom.base.repo?.default_branch || seen.has(base)) break;
    const below = (
      await client.listOpenPullRequests({ owner, repo, head: `${owner}:${base}` }, signal)
    ).filter((json) => sameRepo(json) && json.head.ref === base);
    if (below.length !== 1) break;
    bottom = below[0]!;
    stack.unshift(bottom);
    seen.add(bottom.head.ref);
  }

  let top = start;
  while (stack.length < MAX_STACK_SIZE) {
    const head = top.head.ref;
    const above = (await client.listOpenPullRequests({ owner, repo, base: head }, signal)).filter(
      (json) => sameRepo(json) && json.base.ref === head,
    );
    if (above.length !== 1 || seen.has(above[0]!.head.ref)) break;
    top = above[0]!;
    stack.push(top);
    seen.add(top.head.ref);
  }

  return stack.map(member);
}

export interface RenderPullRequestStackOptions {
  /** Budget shared by every diff; later diffs are cut or left out once it is spent. */
  maxDiffChars?: number;
}

/**
 * The other PRs of `current`'s stack as markdown for the Code review prompt:
 * the stack in order with this PR marked, then each other PR's diff from
 * `diffs` (by PR number), and the rule to report findings only on this PR.
 */
export function renderPullRequestStack(
  members: readonly PullRequestStackMember[],
  current: number,
  diffs: ReadonlyMap<number, string>,
  { maxDiffChars = MAX_PROMPT_DIFF_CHARS }: RenderPullRequestStackOptions = {},
): string {
  const at = members.findIndex((m) => m.number === current);
  const name = (m: PullRequestStackMember) =>
    `#${m.number}: ${m.title} (${m.headRef} → ${m.baseRef})`;
  const order = members
    .map((m, i) => `${i + 1}. ${name(m)}${m.number === current ? " ← this PR" : ""}`)
    .join("\n");

  let budget = maxDiffChars;
  const others = members.flatMap((m, i) => {
    if (m.number === current) return [];
    const where = i < at ? "below this PR" : "above this PR";
    const diff = diffs.get(m.number) ?? "";
    let body: string;
    if (!diff.trim()) {
      body = "No changes.";
    } else if (budget <= 0) {
      body = `The diff (${diff.length} characters) is left out: the prompt's diff budget is spent.`;
    } else if (diff.length > budget) {
      body = `${fence(diff.slice(0, budget), "diff")}\n\nThe diff is cut at ${budget} of ${diff.length} characters.`;
      budget = 0;
    } else {
      body = fence(diff, "diff");
      budget -= diff.length;
    }
    return [`### ${name(m)}, ${where}\n\n${body}`];
  });

  return [
    `This pull request is part of a stack of ${members.length} pull requests, bottom first:`,
    order,
    ...others,
    "PRs below this one are already in the worktree; PRs above are not. Read their changes for context only. Report findings only on this pull request's own changes (the diff under Changes to review); do not report problems that belong to another PR in the stack.",
  ].join("\n\n");
}
