import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SCRATCH_DIR, type Task, type TaskArtifact } from "@blackwall/shared";

/** Where implementers save screenshots, relative to the worktree. */
export const ARTIFACTS_DIR = `${SCRATCH_DIR}/artifacts`;

/** The image types served, by extension. No SVG: it can carry script. */
export const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Largest artifact served. */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

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

function contentTypeOf(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext === undefined ? undefined : ARTIFACT_TYPES[ext];
}

/** A `/`-separated path inside the artifacts folder: no `..`, empty or absolute parts. */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.includes("\0") || isAbsolute(path)) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * The images an implementer saved to `.blackwall/artifacts/` in a task's
 * worktree. The files are untrusted agent output: only raster images are
 * listed and served, never through a symlink, and never above
 * {@link MAX_ARTIFACT_BYTES}.
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
        if (!entry.isFile() || contentTypeOf(entry.name) === undefined) continue;
        const full = join(entry.parentPath, entry.name);
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        artifacts.push({
          path: relative(dir, full).split(sep).join("/"),
          size: info.size,
          modifiedAt: info.mtime,
        });
      }
      return artifacts.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
    },

    /** One artifact's bytes, or null when it is missing, unsafe or not an allowed image. */
    async read(task: Task, path: string): Promise<{ body: Buffer; contentType: string } | null> {
      if (!task.worktreePath || !isSafeRelativePath(path)) return null;
      const contentType = contentTypeOf(path);
      if (!contentType) return null;
      try {
        const dir = await realpath(join(task.worktreePath, ARTIFACTS_DIR));
        const file = await realpath(join(dir, path));
        // Any symlink on the way resolves elsewhere: refuse it.
        if (file !== resolve(dir, path)) return null;
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) return null;
        return { body: await readFile(file), contentType };
      } catch {
        return null;
      }
    },
  };
}

export type TaskArtifacts = ReturnType<typeof createTaskArtifacts>;
