import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConnectionService } from "../connections/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemorySecretStore } from "../secrets/secret-store.js";
import { createConnectionTokens } from "../secrets/tokens.js";
import {
  InvalidRepoError,
  RepoInUseError,
  RepoNotFoundError,
  StaleRepoError,
  createRepoService,
  type RepoService,
} from "./service.js";

let opened: OpenedDatabase;
let r: Repositories;
let service: RepoService;
let root: string;

beforeEach(() => {
  opened = openDatabase(":memory:");
  r = createRepositories(opened.db);
  const tokens = createConnectionTokens({
    store: createMemorySecretStore(),
    connections: r.connections,
    env: {},
  });
  const connections = createConnectionService({ connections: r.connections, tokens });
  service = createRepoService({ repos: r.repos, connections });
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-repos-")));
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A real git repo under the temp root, optionally with an `origin` remote. */
function gitRepo(segments: string[], remote?: string): string {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet");
  if (remote) git(path, "remote", "add", "origin", remote);
  return path;
}

describe("repo service", () => {
  it("registers a repo with its origin, connection and suggested checks", async () => {
    const connection = r.connections.create({
      name: "jbf.ghe.com",
      kind: "github",
      baseUrl: "https://jbf.ghe.com",
    });
    const path = gitRepo(["app"], "git@jbf.ghe.com:team/app.git");
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));

    const repo = await service.add({ path });
    expect(repo).toMatchObject({
      path,
      name: "app",
      remoteUrl: "git@jbf.ghe.com:team/app.git",
      connectionId: connection.id,
      checkCommands: ["npm run test"],
    });
    expect(service.list()).toEqual([{ ...repo, exists: true }]);
  });

  it("keeps given check commands, including none", async () => {
    const path = gitRepo(["app"]);
    writeFileSync(join(path, "go.mod"), "");
    const repo = await service.add({ path, name: "My app", checkCommands: [] });
    expect(repo).toMatchObject({ name: "My app", remoteUrl: null, connectionId: null });
    expect(repo.checkCommands).toEqual([]);
    expect(await service.suggestChecks(repo.id)).toEqual(["go build ./...", "go test ./..."]);
  });

  it("leaves the connection empty for unknown hosts and local remotes", async () => {
    const github = await service.add({ path: gitRepo(["a"], "https://github.com/acme/a.git") });
    const local = await service.add({ path: gitRepo(["b"], root) });
    expect(github.connectionId).toBeNull();
    expect(local.connectionId).toBeNull();
  });

  it("rejects relative paths, plain folders, worktrees and duplicates", async () => {
    await expect(service.add({ path: "relative/app" })).rejects.toThrow(InvalidRepoError);
    await expect(service.add({ path: join(root, "missing") })).rejects.toThrow(/not a folder/);
    mkdirSync(join(root, "plain"));
    await expect(service.add({ path: join(root, "plain") })).rejects.toThrow(/not the root/);
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), "gitdir: /code/app/.git/worktrees/wt\n");
    await expect(service.add({ path: join(root, "wt") })).rejects.toThrow(/worktree/);
    const path = gitRepo(["app"]);
    await service.add({ path });
    await expect(service.add({ path: join(path, ".") })).rejects.toThrow(/already registered/);
  });

  it("registers every repo found by a folder scan and skips registered ones", async () => {
    const paths = [
      gitRepo(["a"]),
      gitRepo(["group", "b"], "https://github.com/acme/b.git"),
      gitRepo(["group", "c"]),
    ];
    gitRepo(["node_modules", "dep"]);
    await service.add({ path: paths[0]! });

    const first = await service.scan({ root });
    expect(first.added.map((repo) => repo.path)).toEqual([paths[1], paths[2]]);
    expect(first.skipped).toEqual([paths[0]]);
    expect(service.list()).toHaveLength(paths.length);
    expect(first.added[0]?.remoteUrl).toBe("https://github.com/acme/b.git");

    const again = await service.scan({ root, maxDepth: 2 });
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual(paths);
  });

  it("warns about and removes a repo whose folder is gone when it is used", async () => {
    const path = gitRepo(["app"]);
    const repo = await service.add({ path });
    expect(service.use(repo.id)).toEqual(repo);

    rmSync(path, { recursive: true, force: true });
    expect(service.list()).toEqual([{ ...repo, exists: false }]);
    const error = (() => {
      try {
        service.use(repo.id);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(StaleRepoError);
    expect(error).toMatchObject({ removed: true, repo: { id: repo.id } });
    expect((error as Error).message).toMatch(/no longer exists .* removed from the registry/);
    expect(service.list()).toEqual([]);
    expect(() => service.use(repo.id)).toThrow(RepoNotFoundError);
  });

  it("keeps a stale repo that tasks still reference", async () => {
    const path = gitRepo(["app"]);
    const repo = await service.add({ path });
    r.tasks.create({ title: "t", origin: { kind: "free-text" }, repoId: repo.id });
    rmSync(path, { recursive: true, force: true });
    expect(() => service.use(repo.id)).toThrow(StaleRepoError);
    expect(service.list()).toHaveLength(1);
    expect(() => service.delete(repo.id)).toThrow(RepoInUseError);
  });

  it("updates names and check commands, refreshes remotes and deletes", async () => {
    const path = gitRepo(["app"]);
    const repo = await service.add({ path, checkCommands: ["make"] });
    expect(service.update(repo.id, { name: "App", checkCommands: [] })).toMatchObject({
      name: "App",
      checkCommands: [],
    });
    expect(() => service.update(repo.id, { name: " " })).toThrow(InvalidRepoError);

    const connection = r.connections.create({
      name: "github.com",
      kind: "github",
      baseUrl: "https://github.com",
    });
    git(path, "remote", "add", "origin", "https://github.com/acme/app.git");
    expect(await service.refresh(repo.id)).toMatchObject({
      remoteUrl: "https://github.com/acme/app.git",
      connectionId: connection.id,
    });

    service.delete(repo.id);
    expect(service.list()).toEqual([]);
    expect(() => service.delete(repo.id)).toThrow(RepoNotFoundError);
  });
});
