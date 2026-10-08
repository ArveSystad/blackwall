/** A pull request as the user pasted it: `https://<host>/<owner>/<repo>/pull/<n>`. */
export interface PullRequestRef {
  /** Web origin of the GitHub host, e.g. `https://github.com` or `https://jbf.ghe.com`. */
  baseUrl: string;
  /** Lower-case host (with a non-default port), for matching connections and remotes. */
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** Canonical PR link, without trailing sub-pages like `/files`. */
  url: string;
}

/** `owner/repo` on a host, as parsed from a git remote. */
export interface RepoSlug {
  host: string;
  owner: string;
  repo: string;
}

const PR_PATH = /^\/([^/]+)\/([^/]+)\/pulls?\/(\d+)(?:\/.*)?$/;

/**
 * Parses a GitHub or GHE pull request URL. Accepts sub-pages (`/files`,
 * `/commits`) and the `/pulls/` spelling. Returns undefined for anything else.
 */
export function parsePullRequestUrl(input: string): PullRequestRef | undefined {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const match = PR_PATH.exec(url.pathname);
  if (!match) return undefined;
  const [, owner, rawRepo, num] = match;
  const number = Number(num);
  if (!owner || !rawRepo || !Number.isSafeInteger(number) || number <= 0) return undefined;
  const repo = rawRepo.replace(/\.git$/i, "");
  const host = url.host.toLowerCase();
  const baseUrl = host === "www.github.com" ? "https://github.com" : url.origin.toLowerCase();
  return {
    baseUrl,
    host: host === "www.github.com" ? "github.com" : host,
    owner,
    repo,
    number,
    url: `${baseUrl}/${owner}/${repo}/pull/${number}`,
  };
}

/** scp-like syntax: `[user@]host:owner/repo(.git)`. */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const SSH_ALIASES: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/**
 * Host and `owner/repo` of a git remote: `https://host/owner/repo.git`,
 * `ssh://git@host:22/owner/repo.git` or `git@host:owner/repo.git`. The SSH
 * port is dropped, an HTTPS port kept. Undefined for local paths.
 */
export function parseRemoteSlug(remote: string): RepoSlug | undefined {
  const value = remote.trim();
  let host: string | undefined;
  let path: string | undefined;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      host = url.protocol === "http:" || url.protocol === "https:" ? url.host : url.hostname;
      path = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  } else if (/^[a-z]:[\\/]/i.test(value)) {
    return undefined;
  } else {
    const match = SCP_LIKE.exec(value);
    host = match?.[1];
    path = match?.[2];
  }
  if (!host || !path) return undefined;
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const lowerHost = host.toLowerCase();
  return {
    host: SSH_ALIASES[lowerHost] ?? lowerHost,
    owner: parts[0],
    repo: parts[1].replace(/\.git$/i, ""),
  };
}

/** Whether a remote points at the PR's repository (host, owner and repo; case-insensitive). */
export function remoteMatchesPullRequest(remote: string, ref: PullRequestRef): boolean {
  const slug = parseRemoteSlug(remote);
  return (
    !!slug &&
    slug.host === ref.host &&
    slug.owner.toLowerCase() === ref.owner.toLowerCase() &&
    slug.repo.toLowerCase() === ref.repo.toLowerCase()
  );
}

/**
 * The registry repo whose `origin` remote is the PR's repository. Undefined
 * means the repo is not registered yet: the UI asks the user to add it.
 */
export function findRepoForPullRequest<R extends { remoteUrl: string | null }>(
  repos: readonly R[],
  ref: PullRequestRef,
): R | undefined {
  return repos.find((r) => r.remoteUrl !== null && remoteMatchesPullRequest(r.remoteUrl, ref));
}
