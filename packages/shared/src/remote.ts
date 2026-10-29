const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const SSH_ALIASES: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/**
 * A git remote as `host/path`, lower-cased and without protocol, credentials,
 * port or `.git`, so `https://github.com/Acme/App.git` and
 * `git@github.com:acme/app` give the same key. Null for local paths
 * (`C:\…`, `/…`, `file://…`), empty and unparseable input.
 */
export function remoteKey(remote: string | null): string | null {
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
  const lowerHost = host.toLowerCase();
  return `${SSH_ALIASES[lowerHost] ?? lowerHost}/${trimmed.toLowerCase()}`;
}
