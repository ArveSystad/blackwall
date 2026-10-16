/** The parts of a pull request that say whose work it is. */
export interface PullRequestOwnership {
  /** The PR author's login; null when GitHub no longer has the user. */
  authorLogin: string | null;
  /** The head repository's `owner/repo`; null when it was deleted (a fork that is gone). */
  headRepo: string | null;
  /** The base repository's `owner/repo`. */
  baseRepo: string;
}

/**
 * Whether a pull request's branch holds only `login`'s own work: the PR comes
 * from the base repository itself (not a fork), `login` opened it, and every
 * commit on it is authored by `login`. A commit whose author email is not
 * linked to a GitHub user (`authorLogin` null) counts as someone else's.
 * Logins and repositories compare case-insensitively; an empty commit list is
 * not owned.
 */
export function pullRequestOwnedBy(
  pr: PullRequestOwnership,
  commits: readonly { authorLogin: string | null }[],
  login: string,
): boolean {
  const me = login.toLowerCase();
  const is = (name: string | null) => name !== null && name.toLowerCase() === me;
  if (pr.headRepo === null || pr.headRepo.toLowerCase() !== pr.baseRepo.toLowerCase()) {
    return false;
  }
  if (!is(pr.authorLogin)) return false;
  if (commits.length === 0) return false;
  return commits.every((commit) => is(commit.authorLogin));
}
