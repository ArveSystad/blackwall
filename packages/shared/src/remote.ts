const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const SSH_ALIASES: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/** A remote's host and path as written, before any normalising; null when unreadable or local. */
function parseRemote(remote: string | null): { host: string; path: string } | null {
  const value = remote?.trim();
  if (!value) return null;
  let host: string | undefined;
  let path: string | undefined;
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.protocol === "file:") return null;
    host = url.hostname;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    return null;
  } else {
    const match = SCP_LIKE.exec(value);
    host = match?.[1];
    path = match?.[2];
  }
  if (!host || !path) return null;
  const trimmed = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!trimmed) return null;
  return { host: SSH_ALIASES[host.toLowerCase()] ?? host, path: trimmed };
}

/**
 * A git remote as `host/path`, lower-cased and without protocol, credentials,
 * port or `.git`, so `https://github.com/Acme/App.git` and
 * `git@github.com:acme/app` give the same key. Null for local paths
 * (`C:\…`, `/…`, `file://…`), empty and unparseable input.
 */
export function remoteKey(remote: string | null): string | null {
  const parsed = parseRemote(remote);
  if (!parsed) return null;
  return `${parsed.host.toLowerCase()}/${parsed.path.toLowerCase()}`;
}

/** A remote's `owner/repo` on its host. */
export interface RemoteRepoSlug {
  host: string;
  owner: string;
  repo: string;
}

/**
 * The remote's host, owner and repo with their original case, parsed as
 * {@link remoteKey} does; null unless the path is exactly `owner/repo`.
 */
export function remoteRepoSlug(remote: string | null): RemoteRepoSlug | null {
  const parsed = parseRemote(remote);
  const segments = parsed?.path.split("/") ?? [];
  if (!parsed || segments.length !== 2) return null;
  const [owner, repo] = segments as [string, string];
  if (!owner || !repo) return null;
  return { host: parsed.host, owner, repo };
}

/**
 * The remote with only its last path segment replaced by `name`. Protocol,
 * credentials, port, the scp-like form and a `.git` suffix stay as they were.
 * Null when the remote has no `owner/repo` slug.
 */
export function renamedRemoteUrl(remote: string, name: string): string | null {
  if (!remoteRepoSlug(remote)) return null;
  const match = /[^/:]+?(\.git)?(\/*)$/i.exec(remote.trim());
  if (!match) return null;
  return `${remote.trim().slice(0, match.index)}${name}${match[1] ?? ""}${match[2] ?? ""}`;
}

/** The folder path with its last segment replaced by `name`, keeping the path's separator. */
export function renamedRepoPath(path: string, name: string): string {
  const match = /[^\\/]+([\\/]*)$/.exec(path);
  if (!match) return path;
  return `${path.slice(0, match.index)}${name}${match[1] ?? ""}`;
}

/** The repo's web address after a rename to `name`: `https://<host>/<owner>/<name>`. */
export function githubRepoUrl(slug: RemoteRepoSlug, name: string): string {
  return `https://${slug.host}/${slug.owner}/${name}`;
}
