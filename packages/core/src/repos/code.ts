import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  MAX_CODE_FILE_BYTES,
  type RepoFile,
  type RepoFileChange,
  type RepoTree,
} from "@blackwall/shared";
import { GitError, runGit } from "../git/service.js";

/** Bytes searched for a NUL to tell a binary file from text, as git does. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Whether `path` is a plain repo-relative path the Code view may read: no NUL,
 * no backslash, not absolute, no empty, `.` or `..` segment, not inside `.git`.
 */
export function isSafeCodePath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || isAbsolute(path)) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return segments[0]!.toLowerCase() !== ".git";
}

/**
 * Each changed path in `git status --porcelain=v1 -z` output with its change,
 * the index and worktree columns combined. A rename is listed under its new
 * path only; ignored files are skipped.
 */
export function parseStatus(output: string): Map<string, NonNullable<RepoFileChange>> {
  const changes = new Map<string, NonNullable<RepoFileChange>>();
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    // A rename or copy is followed by its original path.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++;
    if (x === "!") continue;
    changes.set(path, statusChange(x, y));
  }
  return changes;
}

function statusChange(x: string, y: string): NonNullable<RepoFileChange> {
  if (x === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || x === "C" || y === "A" || y === "C") return "added";
  return "modified";
}

/** The checked-out branch, or `HEAD` when detached. Works before the first commit. */
export async function currentBranch(path: string): Promise<string> {
  try {
    return (await runGit(path, ["symbolic-ref", "--short", "-q", "HEAD"])) || "HEAD";
  } catch (error) {
    if (error instanceof GitError) return "HEAD";
    throw error;
  }
}

async function hasHead(path: string): Promise<boolean> {
  try {
    await runGit(path, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}

async function statusOf(root: string, pathspec: string[] = []) {
  return parseStatus(
    await runGit(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      ...(pathspec.length > 0 ? ["--", ...pathspec] : []),
    ]),
  );
}

async function listedFiles(root: string, pathspec: string[] = []): Promise<string[]> {
  const out = await runGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    ...(pathspec.length > 0 ? ["--", ...pathspec] : []),
  ]);
  return out.split("\0").filter((path) => path !== "");
}

/** The working copy's tracked and untracked, not ignored, files, sorted, with their changes. */
export async function readRepoTree(root: string): Promise<Omit<RepoTree, "activeInRepoTask">> {
  const [branch, listed, changes] = await Promise.all([
    currentBranch(root),
    listedFiles(root),
    statusOf(root),
  ]);
  const paths = new Set(listed);
  // Deleted files are gone from disk and, once staged, from the index too.
  for (const [path, change] of changes) if (change === "deleted") paths.add(path);
  const files = [...paths].sort().map((path) => ({ path, change: changes.get(path) ?? null }));
  return { branch, files };
}

/**
 * One file of the working copy, or `null` when `relPath` is unsafe, not listed
 * by git (e.g. ignored) or outside the repo. Symlinks are never followed.
 * A changed tracked text file comes with its whole-file diff against HEAD; an
 * untracked one, or any file before the first commit, with its content only.
 */
export async function readRepoFile(root: string, relPath: string): Promise<RepoFile | null> {
  if (!isSafeCodePath(relPath)) return null;
  const pathspec = [`:(literal)${relPath}`];
  const [listed, changes, head] = await Promise.all([
    listedFiles(root, pathspec),
    statusOf(root, pathspec),
    hasHead(root),
  ]);
  const statusChange = changes.get(relPath);
  if (!listed.includes(relPath) && statusChange === undefined) return null;
  const change = head ? (statusChange ?? null) : "untracked";
  const diffOf = async () =>
    head
      ? (await runGit(root, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--unified=1000000",
          "HEAD",
          "--",
          ...pathspec,
        ])) || null
      : null;
  const base = { path: relPath, change, size: 0, content: null, diff: null };

  const full = join(root, relPath);
  const info = await lstat(full).catch(() => null);
  if (!info) return { ...base, kind: "deleted", diff: await diffOf() };
  if (info.isSymbolicLink()) return { ...base, kind: "symlink", size: info.size };
  if (!info.isFile() || !(await isInside(root, full))) return null;
  if (info.size > MAX_CODE_FILE_BYTES) return { ...base, kind: "too-large", size: info.size };

  const bytes = await readCapped(full, info.size);
  if (bytes.length > MAX_CODE_FILE_BYTES) return { ...base, kind: "too-large", size: bytes.length };
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { ...base, kind: "binary", size: bytes.length };
  }
  const tracked = change !== null && change !== "untracked";
  return {
    ...base,
    kind: "text",
    size: bytes.length,
    content: bytes.toString("utf8"),
    diff: tracked ? await diffOf() : null,
  };
}

/** Whether the real path of `path` lies inside the real path of `root`. */
async function isInside(root: string, path: string): Promise<boolean> {
  try {
    const rel = relative(await realpath(root), await realpath(path));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * The file's bytes, reading one byte past `size` (at most one past the size
 * cap) so a file that grew since `lstat` is noticed.
 */
async function readCapped(path: string, size: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_CODE_FILE_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
