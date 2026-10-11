import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

/** The server needs this Node major or newer (root `package.json` engines). */
export const MIN_NODE_MAJOR = 22;

export type NodeCheck =
  { ok: true; path: string } | { ok: false; reason: "missing" | "old"; version?: string };

/** Finds an executable on `PATH` (`Path` on Windows, trying each `PATHEXT` extension). */
export function findOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const pathVar = windows ? (env.Path ?? env.PATH) : env.PATH;
  const delimiter = windows ? ";" : ":";
  // On Windows an extensionless match (a shell script shim) cannot be executed directly.
  const extensions = windows
    ? (env.PATHEXT ?? ".EXE;.CMD")
        .split(";")
        .filter(Boolean)
        .map((ext) => ext.toLowerCase())
    : [""];
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `v22.11.0` → 22; `undefined` when the text is not a Node version. */
export function parseNodeMajor(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

/** Finds a system Node new enough to run the server. */
export function checkNode(env: Readonly<Record<string, string | undefined>>): NodeCheck {
  const path = findOnPath("node", env);
  if (!path) return { ok: false, reason: "missing" };
  let version: string;
  try {
    version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return { ok: false, reason: "missing" };
  }
  const major = parseNodeMajor(version);
  if (major === undefined || major < MIN_NODE_MAJOR) return { ok: false, reason: "old", version };
  return { ok: true, path };
}
