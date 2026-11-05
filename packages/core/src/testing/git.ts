import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Repo config every test repo gets, so commits work without a global identity. */
export const TEST_GIT_CONFIG: Readonly<Record<string, string>> = {
  "user.name": "Test",
  "user.email": "test@example.com",
  "commit.gpgsign": "false",
  "core.autocrlf": "false",
};

/** Runs git in `cwd` and returns its stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export interface SeedRepoOptions {
  /** Files of the initial commit, by path relative to the repo. */
  files?: Record<string, string>;
  /** Message of the initial commit. */
  message?: string;
}

let seedRoot: string | undefined;
const seeds = new Map<string, string>();

function freshSeedDir(): string {
  if (!seedRoot) {
    const root = mkdtempSync(join(tmpdir(), "blackwall-seed-"));
    seedRoot = root;
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  }
  return join(seedRoot, String(seeds.size));
}

/** `git init -b main` plus {@link TEST_GIT_CONFIG}, kept in the repo's own config. */
function initRepo(path: string, ...flags: string[]): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", ...flags, "-b", "main");
  for (const [key, value] of Object.entries(TEST_GIT_CONFIG)) git(path, "config", key, value);
}

function commitFiles(repo: string, { files, message }: Required<SeedRepoOptions>): void {
  for (const [file, content] of Object.entries(files)) {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", message);
}

/** Builds a seed once per distinct key and returns its directory. */
function seed(key: string, build: (dir: string) => void): string {
  let dir = seeds.get(key);
  if (!dir) {
    dir = freshSeedDir();
    build(dir);
    seeds.set(key, dir);
  }
  return dir;
}

function withDefaults({
  files = { "README.md": "hello\n" },
  message = "initial",
}: SeedRepoOptions): Required<SeedRepoOptions> {
  return { files, message };
}

function copy(from: string, to: string, filter?: (source: string) => boolean): void {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, ...(filter ? { filter } : {}) });
}

/**
 * Copies a work repo without its index, which git then rebuilds: a copied
 * index has stale stat data, and on Windows a just-copied index can briefly
 * fail to open.
 */
function copyWorkRepo(from: string, to: string): void {
  const index = join(from, ".git", "index");
  copy(from, to, (source) => source !== index);
  git(to, "reset", "--quiet");
}

/**
 * Makes `dest` (which may already exist) a repo on `main` with one commit of
 * `files`, copied from a seed built once per test file instead of running git
 * init, config and commit for every test.
 */
export function copySeedRepo(dest: string, options: SeedRepoOptions = {}): void {
  const resolved = withDefaults(options);
  const dir = seed(JSON.stringify({ kind: "repo", ...resolved }), (dir) => {
    initRepo(dir);
    commitFiles(dir, resolved);
  });
  copyWorkRepo(dir, dest);
}

/**
 * {@link copySeedRepo} plus a bare `origin` the commit was pushed to: `repo`'s
 * `origin` remote points at the `origin` copy.
 */
export function copySeedRepoWithOrigin(
  repo: string,
  origin: string,
  options: SeedRepoOptions = {},
): void {
  const resolved = withDefaults(options);
  const dir = seed(JSON.stringify({ kind: "origin", ...resolved }), (dir) => {
    const seedOrigin = join(dir, "origin.git");
    const seedRepo = join(dir, "repo");
    initRepo(seedOrigin, "--bare");
    initRepo(seedRepo);
    git(seedRepo, "remote", "add", "origin", seedOrigin);
    commitFiles(seedRepo, resolved);
    git(seedRepo, "push", "--quiet", "origin", "main");
  });
  copy(join(dir, "origin.git"), origin);
  copyWorkRepo(join(dir, "repo"), repo);
  git(repo, "remote", "set-url", "origin", origin);
}
