import { type FileHandle, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import {
  type ArtifactKind,
  MAX_ARTIFACT_BYTES,
  SCRATCH_DIR,
  type Task,
  type TaskArtifact,
} from "@blackwall/shared";

/** Where implementers save files for the reviewer, relative to the worktree. */
export const ARTIFACTS_DIR = `${SCRATCH_DIR}/artifacts`;

/** The image types served inline, by extension. No SVG: it can carry script. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Extensions served inline as `text/plain`, so markup like HTML or SVG shows as source. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "csv",
  "tsv",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "scss",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "cs",
  "fs",
  "c",
  "h",
  "cpp",
  "hpp",
  "swift",
  "php",
  "sql",
  "sh",
  "ps1",
  "bat",
  "diff",
  "patch",
  "graphql",
  "proto",
  "tf",
  "bicep",
  "dockerfile",
]);

/** Extensionless file names, in lowercase, that are text too. */
export const TEXT_NAMES: ReadonlySet<string> = new Set(["dockerfile", "makefile"]);

/**
 * How an artifact is served, by its extension: raster images as themselves,
 * known text as `text/plain`, and anything else as an octet-stream download.
 */
export function artifactKindOf(path: string): { kind: ArtifactKind; contentType: string } {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const ext = /\.([a-z0-9]+)$/.exec(name)?.[1];
  const image = ext === undefined ? undefined : IMAGE_TYPES[ext];
  if (image) return { kind: "image", contentType: image };
  if (ext === undefined ? TEXT_NAMES.has(name) : TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", contentType: "text/plain; charset=utf-8" };
  }
  return { kind: "file", contentType: "application/octet-stream" };
}

/**
 * Creates the worktree's scratch folder with a `.gitignore` that ignores
 * everything in it, so the harness's `git add -A` never stages artifacts.
 */
export async function ensureScratchDir(worktree: string): Promise<string> {
  const dir = join(worktree, SCRATCH_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "w" });
  return dir;
}

/** Whether any part of a `/`-separated path is hidden, like `.DS_Store`. */
function isDotPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

/** A `/`-separated path inside the artifacts folder: no `..`, empty, hidden or absolute parts. */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0") || isAbsolute(path)) return false;
  return path.split("/").every((part) => part !== "" && !part.startsWith("."));
}

/**
 * An artifact ready to serve: images and text as their bytes, other files as
 * a stream. The `stream` factory owns an open file handle and must be called
 * exactly once; the stream closes the handle when it ends or is destroyed.
 */
export type ArtifactContent =
  | { kind: "image" | "text"; contentType: string; size: number; body: Buffer }
  | { kind: "file"; contentType: string; size: number; stream: () => Readable };

/**
 * The files an implementer saved to `.blackwall/artifacts/` in a task's
 * worktree. The files are untrusted agent output: they are never read through
 * a symlink, images and text above {@link MAX_ARTIFACT_BYTES} are refused and
 * other files stream, dotfiles are skipped, and each gets a type from
 * {@link artifactKindOf} that can't run as script.
 */
export function createTaskArtifacts() {
  return {
    /** The task's artifacts, newest first. Empty without a worktree or folder. */
    async list(task: Task): Promise<TaskArtifact[]> {
      if (!task.worktreePath) return [];
      const dir = join(task.worktreePath, ARTIFACTS_DIR);
      const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
      const artifacts: TaskArtifact[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = join(entry.parentPath, entry.name);
        const path = relative(dir, full).split(sep).join("/");
        if (isDotPath(path)) continue;
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        artifacts.push({
          path,
          size: info.size,
          modifiedAt: info.mtime,
          kind: artifactKindOf(path).kind,
        });
      }
      return artifacts.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    },

    /**
     * One artifact and how to serve it, or null when it is missing, unsafe, or
     * an image or text file over the cap. Other files come as a stream.
     */
    async read(task: Task, path: string): Promise<ArtifactContent | null> {
      if (!task.worktreePath || !isSafeRelativePath(path)) return null;
      let handle: FileHandle | undefined;
      let keepOpen = false;
      try {
        const dir = await realpath(join(task.worktreePath, ARTIFACTS_DIR));
        const file = await realpath(join(dir, path));
        // Any symlink on the way resolves elsewhere: refuse it.
        if (file !== resolve(dir, path)) return null;
        // Refuse special files before opening: opening a FIFO blocks.
        if (!(await stat(file)).isFile()) return null;
        // Size and bytes come from the same open file.
        handle = await open(file, "r");
        const info = await handle.stat();
        if (!info.isFile()) return null;
        const { kind, contentType } = artifactKindOf(path);
        if (kind === "file") {
          const opened = handle;
          keepOpen = true;
          return { kind, contentType, size: info.size, stream: () => opened.createReadStream() };
        }
        if (info.size > MAX_ARTIFACT_BYTES) return null;
        return { kind, contentType, size: info.size, body: await handle.readFile() };
      } catch {
        return null;
      } finally {
        if (handle && !keepOpen) await handle.close().catch(() => {});
      }
    },
  };
}

export type TaskArtifacts = ReturnType<typeof createTaskArtifacts>;
