import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACTS_DIR, createTaskArtifacts, ensureScratchDir } from "./artifacts.js";

let root: string;
let worktree: string;
let dir: string;
const artifacts = createTaskArtifacts();

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-artifacts-")));
  worktree = join(root, "wt");
  dir = join(worktree, ARTIFACTS_DIR);
  mkdirSync(worktree);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const taskIn = (worktreePath: string | null) => ({ worktreePath }) as Task;

function write(path: string, content: string | Buffer, mtime?: Date): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  if (mtime) utimesSync(full, mtime, mtime);
}

/** Whether this OS lets the test create symlinks (Windows needs a privilege). */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch {
    return false;
  }
}

describe("task artifacts", () => {
  it("lists nothing without a worktree or folder", async () => {
    expect(await artifacts.list(taskIn(null))).toEqual([]);
    expect(await artifacts.list(taskIn(worktree))).toEqual([]);
  });

  it("lists nested images with / paths, newest first, skipping other files", async () => {
    write("home.png", "a", new Date("2026-01-01T00:00:00Z"));
    write("pages/login/form.webp", "bb", new Date("2026-01-02T00:00:00Z"));
    write("icon.svg", "<svg/>");
    write("notes.txt", "hi");
    await ensureScratchDir(worktree);

    expect(await artifacts.list(taskIn(worktree))).toEqual([
      { path: "pages/login/form.webp", size: 2, modifiedAt: new Date("2026-01-02T00:00:00Z") },
      { path: "home.png", size: 1, modifiedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
  });

  it("reads an image with its content type", async () => {
    write("shots/home.PNG", Buffer.from([1, 2, 3]));
    expect(await artifacts.read(taskIn(worktree), "shots/home.PNG")).toEqual({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/png",
    });
    expect(await artifacts.read(taskIn(worktree), "shots/missing.png")).toBeNull();
    expect(await artifacts.read(taskIn(null), "shots/home.PNG")).toBeNull();
  });

  it("refuses paths outside the folder and types other than raster images", async () => {
    write("icon.svg", "<svg/>");
    writeFileSync(join(worktree, "secret.png"), "secret");
    const task = taskIn(worktree);
    expect(await artifacts.read(task, "../../secret.png")).toBeNull();
    expect(await artifacts.read(task, "a/../../../secret.png")).toBeNull();
    expect(await artifacts.read(task, "..\\..\\secret.png")).toBeNull();
    expect(await artifacts.read(task, join(worktree, "secret.png"))).toBeNull();
    expect(await artifacts.read(task, "/etc/x.png")).toBeNull();
    expect(await artifacts.read(task, "icon.svg")).toBeNull();
  });

  it("skips and refuses symlinks", async (ctx) => {
    writeFileSync(join(worktree, "secret.png"), "secret");
    write("real.png", "real");
    if (!trySymlink(join(worktree, "secret.png"), join(dir, "outside.png"))) ctx.skip();
    trySymlink(join(dir, "real.png"), join(dir, "inside.png"));

    const task = taskIn(worktree);
    expect((await artifacts.list(task)).map((a) => a.path)).toEqual(["real.png"]);
    expect(await artifacts.read(task, "outside.png")).toBeNull();
    expect(await artifacts.read(task, "inside.png")).toBeNull();
  });

  it("keeps the scratch folder out of git", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
    git("init", "--quiet", "-b", "main");
    write("home.png", "png");
    await ensureScratchDir(worktree);
    await ensureScratchDir(worktree);
    expect(readFileSync(join(worktree, ".blackwall", ".gitignore"), "utf8")).toBe("*\n");
    expect(git("status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});
