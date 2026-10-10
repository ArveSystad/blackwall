/**
 * Host of an http(s) URL in lower case, with a non-default port kept
 * (`https://ACME.ghe.com/x` → `acme.ghe.com`). `undefined` when it is not a URL.
 */
export function urlHost(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    return parsed.host ? parsed.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** GitHub serves SSH over port 443 from this host; it is still github.com. */
const SSH_ALIASES: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/** scp-like syntax: `[user@]host:path`, with no scheme and no slash before the colon. */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)/;

/**
 * Host of a git remote URL, for matching it to a GitHub connection. Handles
 * `https://host/owner/repo.git`, `ssh://git@host:22/owner/repo.git` and
 * `git@host:owner/repo.git`. SSH ports are dropped since they say nothing about
 * the web host; an HTTPS port is kept. `undefined` for local paths.
 */
export function gitRemoteHost(remote: string): string | undefined {
  const value = remote.trim();
  let host: string | undefined;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      host = url.protocol === "http:" || url.protocol === "https:" ? url.host : url.hostname;
    } catch {
      return undefined;
    }
  } else if (/^[a-z]:[\\/]/i.test(value)) {
    return undefined; // Windows drive path
  } else {
    host = SCP_LIKE.exec(value)?.[1];
  }
  if (!host) return undefined;
  host = host.toLowerCase();
  return SSH_ALIASES[host] ?? host;
}

/** Origin of a connection base URL, without path or trailing slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl.trim()).origin;
}
