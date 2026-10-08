import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { gitDirKind } from "./git.js";

/** Folders never searched for repos: dependencies and hidden folders (`.git`, `.cache`, …). */
function skipFolder(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/**
 * Git repos at or below `root`, at most `maxDepth` folder levels down. A repo's
 * own subfolders are not searched (submodules and vendored repos belong to it),
 * linked worktrees are left out and symlinks are not followed. Paths are sorted.
 */
export async function findGitRepos(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  let level = [root];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const kind = await gitDirKind(dir);
      if (kind === "repo") found.push(dir);
      if (kind !== "none" || depth === maxDepth) continue;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && !skipFolder(entry.name)) next.push(join(dir, entry.name));
      }
    }
    level = next;
  }
  return found.sort();
}
