import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ARTIFACT_BYTES, type Task } from "@blackwall/shared";
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

  it("lists nested files of every kind with / paths, newest first, skipping dotfiles", async () => {
    write("home.png", "a", new Date("2026-01-01T00:00:00Z"));
    write("pages/login/form.webp", "bb", new Date("2026-01-02T00:00:00Z"));
    write("notes.md", "# hi", new Date("2026-01-03T00:00:00Z"));
    write("bundle.zip", "zip", new Date("2026-01-04T00:00:00Z"));
    write("icon.svg", "<svg/>", new Date("2026-01-05T00:00:00Z"));
    write("build/Dockerfile", "FROM x", new Date("2025-12-31T00:00:00Z"));
    write(".DS_Store", "x");
    write(".cache/hidden.md", "x");
    await ensureScratchDir(worktree);

    expect(await artifacts.list(taskIn(worktree))).toEqual([
      { path: "icon.svg", size: 6, modifiedAt: new Date("2026-01-05T00:00:00Z"), kind: "text" },
      { path: "bundle.zip", size: 3, modifiedAt: new Date("2026-01-04T00:00:00Z"), kind: "file" },
      { path: "notes.md", size: 4, modifiedAt: new Date("2026-01-03T00:00:00Z"), kind: "text" },
      {
        path: "pages/login/form.webp",
        size: 2,
        modifiedAt: new Date("2026-01-02T00:00:00Z"),
        kind: "image",
      },
      { path: "home.png", size: 1, modifiedAt: new Date("2026-01-01T00:00:00Z"), kind: "image" },
      {
        path: "build/Dockerfile",
        size: 6,
        modifiedAt: new Date("2025-12-31T00:00:00Z"),
        kind: "text",
      },
    ]);
  });

  it("reads an image with its content type", async () => {
    write("shots/home.PNG", Buffer.from([1, 2, 3]));
    expect(await artifacts.read(taskIn(worktree), "shots/home.PNG")).toEqual({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/png",
      kind: "image",
    });
    expect(await artifacts.read(taskIn(worktree), "shots/missing.png")).toBeNull();
    expect(await artifacts.read(taskIn(null), "shots/home.PNG")).toBeNull();
  });

  it("reads text as text/plain, markup included", async () => {
    write("notes.md", "# hi");
    write("icon.svg", "<svg/>");
    write("page.html", "<script>alert(1)</script>");
    const task = taskIn(worktree);
    expect(await artifacts.read(task, "notes.md")).toEqual({
      body: Buffer.from("# hi"),
      contentType: "text/plain; charset=utf-8",
      kind: "text",
    });
    expect(await artifacts.read(task, "icon.svg")).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      kind: "text",
    });
    expect(await artifacts.read(task, "page.html")).toMatchObject({
      contentType: "text/plain; charset=utf-8",
      kind: "text",
    });
  });

  it("reads other files as an octet-stream download", async () => {
    write("bundle.zip", "zip");
    write("report.pdf", "pdf");
    write("noext", "x");
    const task = taskIn(worktree);
    expect(await artifacts.read(task, "bundle.zip")).toEqual({
      body: Buffer.from("zip"),
      contentType: "application/octet-stream",
      kind: "file",
    });
    expect(await artifacts.read(task, "report.pdf")).toMatchObject({ kind: "file" });
    expect(await artifacts.read(task, "noext")).toMatchObject({ kind: "file" });
  });

  it("refuses dotfiles", async () => {
    write(".DS_Store", "x");
    write(".cache/notes.md", "x");
    const task = taskIn(worktree);
    expect(await artifacts.read(task, ".DS_Store")).toBeNull();
    expect(await artifacts.read(task, ".cache/notes.md")).toBeNull();
  });

  it("refuses files over the size cap", async () => {
    write("big.zip", "");
    truncateSync(join(dir, "big.zip"), MAX_ARTIFACT_BYTES + 1);
    write("max.zip", "");
    truncateSync(join(dir, "max.zip"), MAX_ARTIFACT_BYTES);
    const task = taskIn(worktree);
    expect(await artifacts.read(task, "big.zip")).toBeNull();
    expect((await artifacts.read(task, "max.zip"))?.body.length).toBe(MAX_ARTIFACT_BYTES);
  });

  it("refuses paths outside the folder", async () => {
    for (const name of ["secret.png", "secret.md", "secret.zip"]) {
      writeFileSync(join(worktree, name), "secret");
    }
    const task = taskIn(worktree);
    for (const name of ["secret.png", "secret.md", "secret.zip"]) {
      expect(await artifacts.read(task, `../../${name}`)).toBeNull();
      expect(await artifacts.read(task, `a/../../../${name}`)).toBeNull();
      expect(await artifacts.read(task, `..\\..\\${name}`)).toBeNull();
      expect(await artifacts.read(task, join(worktree, name))).toBeNull();
      expect(await artifacts.read(task, `/etc/${name}`)).toBeNull();
    }
  });

  it("skips and refuses symlinks", async (ctx) => {
    writeFileSync(join(worktree, "secret.png"), "secret");
    writeFileSync(join(worktree, "secret.md"), "secret");
    writeFileSync(join(worktree, "secret.zip"), "secret");
    write("real.png", "real");
    if (!trySymlink(join(worktree, "secret.png"), join(dir, "outside.png"))) ctx.skip();
    trySymlink(join(worktree, "secret.md"), join(dir, "outside.md"));
    trySymlink(join(worktree, "secret.zip"), join(dir, "outside.zip"));
    trySymlink(join(dir, "real.png"), join(dir, "inside.png"));

    const task = taskIn(worktree);
    expect((await artifacts.list(task)).map((a) => a.path)).toEqual(["real.png"]);
    expect(await artifacts.read(task, "outside.png")).toBeNull();
    expect(await artifacts.read(task, "outside.md")).toBeNull();
    expect(await artifacts.read(task, "outside.zip")).toBeNull();
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
