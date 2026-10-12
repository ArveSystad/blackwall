import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface ResolvedCommand {
  command: string;
  /** Arguments to place before the caller's own. */
  args: string[];
}

export interface ResolveCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reads an env var by name, ignoring case (Windows uses `Path`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isExecutable(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".exe" || ext === ".com";
}

/**
 * The script a `.cmd` shim launches: the last quoted `%dp0%` / `%~dp0` path
 * before `%*`, relative to the shim's directory. Covers npm cmd-shim and pnpm.
 */
export function parseCmdShimTarget(text: string): string | undefined {
  let target: string | undefined;
  for (const match of text.matchAll(/"%~?dp0%?\\?([^"]+)"\s+%\*/g)) target = match[1];
  return target;
}

function resolveShim(shim: string, dir: string): ResolvedCommand | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  const target = parseCmdShimTarget(text);
  if (target === undefined) return undefined;
  const path = join(dir, ...target.split(/[\\/]/));
  if (!isFile(path)) return undefined;
  return isExecutable(path)
    ? { command: path, args: [] }
    : { command: process.execPath, args: [path] };
}

/**
 * Makes a bare command name spawnable without a shell. On Windows, Node only
 * finds `.exe` files on `PATH` and refuses to spawn `.cmd`/`.bat` directly, so
 * an npm/pnpm `.cmd` shim is unwrapped to the binary or Node script it runs.
 * Anything else (other platforms, paths, unparseable shims, misses) comes back
 * unchanged, so spawning fails the usual way.
 */
export function resolveCommand(
  command: string,
  { platform = process.platform, env = process.env }: ResolveCommandOptions = {},
): ResolvedCommand {
  const unchanged: ResolvedCommand = { command, args: [] };
  if (platform !== "win32" || /[\\/]/.test(command) || extname(command) !== "") return unchanged;
  const extensions = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .filter(Boolean)
    .map((ext) => ext.toLowerCase());
  for (const dir of (envValue(env, "PATH") ?? "").split(";")) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (!isFile(candidate)) continue;
      if (ext === ".exe" || ext === ".com") return { command: candidate, args: [] };
      if (ext === ".cmd" || ext === ".bat") return resolveShim(candidate, dir) ?? unchanged;
    }
  }
  return unchanged;
}
