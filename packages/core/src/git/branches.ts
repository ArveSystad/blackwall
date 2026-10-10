import { basename, dirname, join } from "node:path";

/** Longest slug kept in a Jira branch name, cut at a word boundary. */
export const MAX_SLUG_LENGTH = 50;

/** What a task's branch is derived from. */
export type BranchSource =
  /** Work on PR: commits go to the PR's head branch. */
  | { kind: "github-pr"; headBranch: string }
  /** Jira: `feature/<key>-<slug>`, or `fix/…` when the issue type is Bug. */
  | { kind: "jira-issue"; key: string; title: string; issueType: string }
  /** GitHub issue: `feature/<number>-<slug>`, or `fix/…` when it has a `bug` label. */
  | { kind: "github-issue"; number: number; title: string; bug: boolean }
  /** Free text: a temp branch `agent/<task-id>`. */
  | { kind: "free-text"; taskId: string };

/**
 * Lower-case, hyphenated ASCII slug of a title: accents are stripped, every
 * other run of non-alphanumerics becomes one hyphen, and long slugs are cut
 * at a word boundary.
 */
export function slugify(title: string, maxLength = MAX_SLUG_LENGTH): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > maxLength) break;
    slug = next;
  }
  // A single over-long first word is cut rather than dropped.
  return slug || (words[0]?.slice(0, maxLength) ?? "");
}

/** The branch a task works on, per the branch rules in AGENTS.md (Design rules). */
export function branchForTask(source: BranchSource): string {
  switch (source.kind) {
    case "github-pr":
      return source.headBranch;
    case "jira-issue": {
      const prefix = source.issueType.trim().toLowerCase() === "bug" ? "fix" : "feature";
      const slug = slugify(source.title);
      const key = source.key.toLowerCase();
      return `${prefix}/${slug ? `${key}-${slug}` : key}`;
    }
    case "github-issue": {
      const slug = slugify(source.title);
      return `${source.bug ? "fix" : "feature"}/${slug ? `${source.number}-${slug}` : source.number}`;
    }
    case "free-text":
      return `agent/${source.taskId}`;
  }
}

/** Where a task's worktree lives: `../<repo>.worktrees/<task>` next to the repo. */
export function worktreePathFor(repoPath: string, taskId: string): string {
  return join(dirname(repoPath), `${basename(repoPath)}.worktrees`, taskId);
}
