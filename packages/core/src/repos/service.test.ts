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
  RepoPushError,
  StaleRepoError,
  createRepoService,
  referenceReposOf,
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
      name: "acme.ghe.com",
      kind: "github",
      baseUrl: "https://acme.ghe.com",
    });
    const path = gitRepo(["app"], "git@acme.ghe.com:team/app.git");
    writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));

    const repo = await service.add({ path });
    expect(repo).toMatchObject({
      path,
      name: "app",
      remoteUrl: "git@acme.ghe.com:team/app.git",
      connectionId: connection.id,
      checkCommands: ["npm run test"],
      defaultCli: "claude",
      defaultOrigin: "jira-issue",
      maxBacklogTasks: null,
      defaultBranch: "main",
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

  it("reorders repos when every repo is listed exactly once", async () => {
    const [a, b, c] = [
      await service.add({ path: gitRepo(["a"]) }),
      await service.add({ path: gitRepo(["b"]) }),
      await service.add({ path: gitRepo(["c"]) }),
    ];
    const names = () => service.list().map((repo) => repo.name);
    expect(names()).toEqual(["a", "b", "c"]);

    expect(service.reorder([c!.id, a!.id, b!.id]).map((repo) => repo.name)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(names()).toEqual(["c", "a", "b"]);

    expect(() => service.reorder([a!.id, b!.id])).toThrow(InvalidRepoError);
    expect(() => service.reorder([a!.id, b!.id, c!.id, "other"])).toThrow(InvalidRepoError);
    expect(() => service.reorder([a!.id, b!.id, "other"])).toThrow(InvalidRepoError);
    expect(() => service.reorder([a!.id, a!.id, b!.id])).toThrow(InvalidRepoError);
    expect(names()).toEqual(["c", "a", "b"]);

    service.update(b!.id, { favorite: true });
    expect(names()).toEqual(["b", "c", "a"]);
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
    expect(service.update(repo.id, { defaultCli: "copilot" })).toMatchObject({
      name: "App",
      defaultCli: "copilot",
    });
    expect(service.get(repo.id).defaultCli).toBe("copilot");
    expect(service.update(repo.id, { defaultOrigin: "github-pr" })).toMatchObject({
      name: "App",
      defaultOrigin: "github-pr",
    });
    expect(service.get(repo.id).defaultOrigin).toBe("github-pr");
    expect(service.update(repo.id, { maxBacklogTasks: 2 })).toMatchObject({ maxBacklogTasks: 2 });
    expect(service.get(repo.id).maxBacklogTasks).toBe(2);
    expect(service.update(repo.id, { name: "App" }).maxBacklogTasks).toBe(2);
    expect(service.update(repo.id, { maxBacklogTasks: null }).maxBacklogTasks).toBeNull();
    expect(() => service.update(repo.id, { maxBacklogTasks: 0 })).toThrow(InvalidRepoError);
    expect(service.update(repo.id, { watchCi: false }).watchCi).toBe(false);
    expect(service.get(repo.id).watchCi).toBe(false);
    expect(service.update(repo.id, { defaultBranch: " trunk " })).toMatchObject({
      defaultBranch: "trunk",
    });
    expect(service.get(repo.id).defaultBranch).toBe("trunk");
    expect(() => service.update(repo.id, { defaultBranch: "-x" })).toThrow(InvalidRepoError);
    expect(() => service.update(repo.id, { defaultBranch: "" })).toThrow(InvalidRepoError);
    expect(service.update(repo.id, { favorite: true })).toMatchObject({ favorite: true });

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

describe("agent trust", () => {
  it("starts locked with project MCP and hooks off, and updates all three", async () => {
    const app = await service.add({ path: gitRepo(["app"]) });
    expect(app).toMatchObject({
      agentTrust: "locked",
      trustProjectMcp: false,
      trustProjectHooks: false,
    });

    expect(
      service.update(app.id, {
        agentTrust: "trusted",
        trustProjectMcp: true,
        trustProjectHooks: true,
      }),
    ).toMatchObject({ agentTrust: "trusted", trustProjectMcp: true, trustProjectHooks: true });
    expect(service.get(app.id)).toMatchObject({
      agentTrust: "trusted",
      trustProjectMcp: true,
      trustProjectHooks: true,
    });

    expect(service.update(app.id, { agentTrust: "unrestricted" }).agentTrust).toBe("unrestricted");
    expect(service.update(app.id, { trustProjectHooks: false })).toMatchObject({
      agentTrust: "unrestricted",
      trustProjectMcp: true,
      trustProjectHooks: false,
    });
    expect(() => service.update(app.id, { agentTrust: "wide-open" as "locked" })).toThrow(
      InvalidRepoError,
    );
  });
});

describe("reference repos", () => {
  it("accepts other registered repos and rejects itself, unknown ids and duplicates", async () => {
    const app = await service.add({ path: gitRepo(["app"]) });
    const lib = await service.add({ path: gitRepo(["lib"]) });
    expect(app.referenceRepoIds).toEqual([]);
    expect(service.update(app.id, { referenceRepoIds: [lib.id] }).referenceRepoIds).toEqual([
      lib.id,
    ]);
    expect(service.get(app.id).referenceRepoIds).toEqual([lib.id]);

    expect(() => service.update(app.id, { referenceRepoIds: [app.id] })).toThrow(
      /its own reference repo/,
    );
    expect(() => service.update(app.id, { referenceRepoIds: ["missing"] })).toThrow(
      InvalidRepoError,
    );
    expect(() => service.update(app.id, { referenceRepoIds: [lib.id, lib.id] })).toThrow(
      /only once/,
    );
    expect(service.get(app.id).referenceRepoIds).toEqual([lib.id]);
    expect(service.update(app.id, { referenceRepoIds: [] }).referenceRepoIds).toEqual([]);
  });

  it("drops a deleted repo from every other repo's list", async () => {
    const app = await service.add({ path: gitRepo(["app"]) });
    const lib = await service.add({ path: gitRepo(["lib"]) });
    const api = await service.add({ path: gitRepo(["api"]) });
    service.update(app.id, { referenceRepoIds: [lib.id, api.id] });
    service.update(api.id, { referenceRepoIds: [lib.id] });

    service.delete(lib.id);
    expect(service.get(app.id).referenceRepoIds).toEqual([api.id]);
    expect(service.get(api.id).referenceRepoIds).toEqual([]);
  });

  it("drops a stale repo removed on use from every other repo's list", async () => {
    const app = await service.add({ path: gitRepo(["app"]) });
    const libPath = gitRepo(["lib"]);
    const lib = await service.add({ path: libPath });
    service.update(app.id, { referenceRepoIds: [lib.id] });
    rmSync(libPath, { recursive: true, force: true });
    expect(() => service.use(lib.id)).toThrow(StaleRepoError);
    expect(service.get(app.id).referenceRepoIds).toEqual([]);
  });

  it("resolves names and paths, skipping missing folders, unknown ids and the repo itself", async () => {
    const app = await service.add({ path: gitRepo(["app"]) });
    const lib = await service.add({ path: gitRepo(["lib"]) });
    const goneDir = gitRepo(["gone"]);
    const gone = await service.add({ path: goneDir });
    service.update(app.id, { referenceRepoIds: [lib.id, gone.id] });
    rmSync(goneDir, { recursive: true, force: true });
    // Ids written behind the service's back (e.g. an older import) are skipped too.
    r.repos.update(app.id, {
      referenceRepoIds: [...service.get(app.id).referenceRepoIds, app.id, "missing"],
    });

    expect(referenceReposOf(r.repos, app.id)).toEqual([{ name: "lib", path: lib.path }]);
    expect(referenceReposOf(r.repos, lib.id)).toEqual([]);
    expect(referenceReposOf(r.repos, "missing")).toEqual([]);
  });
});

describe("pushing main", () => {
  let origin: string;
  let path: string;

  function out(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  function configure(dir: string): void {
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "core.autocrlf", "false");
  }

  function commit(dir: string, file: string): string {
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", `edit ${file}`);
    return out(dir, "rev-parse", "HEAD");
  }

  /** A clone of a bare origin with one pushed commit on `branch`. */
  function cloneWithOrigin(branch = "main"): void {
    origin = join(root, "origin.git");
    path = join(root, "app");
    git(root, "init", "--quiet", "--bare", "-b", branch, origin);
    mkdirSync(path);
    git(path, "init", "--quiet", "-b", branch);
    configure(path);
    git(path, "remote", "add", "origin", origin);
    commit(path, "README.md");
    git(path, "push", "--quiet", "origin", branch);
  }

  it("pushes local main to origin", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    const sha = commit(path, "a.txt");
    expect(await service.sync(repo.id)).toEqual({ branch: "main", ahead: 1, behind: 0 });

    expect(await service.push(repo.id)).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(out(origin, "rev-parse", "refs/heads/main")).toBe(sha);
  });

  it("pushes main while another branch is checked out", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    git(path, "checkout", "--quiet", "-b", "feature");
    const sha = commit(path, "b.txt");
    git(path, "update-ref", "refs/heads/main", sha);

    await service.push(repo.id);
    expect(out(origin, "rev-parse", "refs/heads/main")).toBe(sha);
    expect(() => out(origin, "rev-parse", "--verify", "--quiet", "refs/heads/feature")).toThrow();
  });

  it("refuses when there is nothing to push or no origin main", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    await expect(service.push(repo.id)).rejects.toThrow("Nothing to push");

    const bare = await service.add({ path: gitRepo(["bare"]) });
    expect(await service.sync(bare.id)).toBeNull();
    await expect(service.push(bare.id)).rejects.toThrow(InvalidRepoError);
  });

  it("refuses a diverged main and leaves the remote alone", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    configure(other);
    const remoteSha = commit(other, "theirs.txt");
    git(other, "push", "--quiet", "origin", "main");
    git(path, "fetch", "--quiet", "origin");
    commit(path, "ours.txt");

    expect(await service.sync(repo.id)).toEqual({ branch: "main", ahead: 1, behind: 1 });
    await expect(service.push(repo.id)).rejects.toThrow("pull first");
    expect(out(origin, "rev-parse", "refs/heads/main")).toBe(remoteSha);
  });

  it("reports git's refusal as a push error", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho nope >&2\nexit 1\n", {
      mode: 0o755,
    });
    commit(path, "a.txt");

    const error = await service.push(repo.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepoPushError);
    expect((error as Error).message).toContain("nope");
  });

  it("says what to do when the remote cannot be reached, without credentials", async () => {
    cloneWithOrigin();
    const repo = await service.add({ path });
    git(path, "remote", "set-url", "--push", "origin", "http://user:secret@127.0.0.1:1/app.git");
    commit(path, "a.txt");

    const error = await service.push(repo.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RepoPushError);
    expect((error as Error).message).toMatch(
      /^Could not reach the remote\. Check the connection and retry\. \(fatal: unable to access 'http:\/\/127\.0\.0\.1:1\/app\.git\/'/,
    );
    expect((error as Error).message).not.toContain("secret");
  }, 15_000);

  it("tracks the repo's default branch", async () => {
    cloneWithOrigin("trunk");
    const repo = await service.add({ path });
    service.update(repo.id, { defaultBranch: "trunk" });
    const sha = commit(path, "a.txt");

    expect(await service.sync(repo.id)).toEqual({ branch: "trunk", ahead: 1, behind: 0 });
    await service.push(repo.id);
    expect(out(origin, "rev-parse", "refs/heads/trunk")).toBe(sha);
  });
});
