import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnectionService,
  createConnectionTokens,
  createMemorySecretStore,
  createRepoRenameLocks,
  createRepoService,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
} from "@blackwall/core";
import {
  STALE_REPO_STATUS,
  repoRenameResultSchema,
  repoScanResultSchema,
  repoSchema,
  repoSyncSchema,
  repoViewSchema,
  staleRepoSchema,
  type ServerEvent,
} from "@blackwall/shared";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";
import { errorResponse } from "./errors.js";
import { repoRoutes } from "./repos.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

let opened: OpenedDatabase;
let root: string;
let app: ReturnType<typeof createApp>["app"];
/** Repos whose Run project run the routes stopped. */
let stopped: string[];

beforeEach(() => {
  opened = openDatabase(":memory:");
  const repositories = createRepositories(opened.db);
  const tokens = createConnectionTokens({
    store: createMemorySecretStore(),
    connections: repositories.connections,
    env: {},
  });
  const connections = createConnectionService({ connections: repositories.connections, tokens });
  const repos = createRepoService({ repos: repositories.repos, connections });
  stopped = [];
  app = createApp({
    token: launchToken,
    getPort: () => port,
    repos,
    projectRuns: {
      list: () => [],
      start: () => {
        throw new Error("not used");
      },
      stop: async (id) => void stopped.push(id),
      output: () => null,
    },
  }).app;
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-repo-routes-")));
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`http://${host}${path}`, {
    method: init.method ?? "GET",
    headers: { host, cookie, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function gitRepo(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: path, stdio: "ignore" });
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commit(dir: string, file: string): string {
  writeFileSync(join(dir, file), `${file}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", `edit ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

/** A git repo with a bare `origin` and one pushed commit on main. */
function clonedRepo(name: string): { path: string; origin: string } {
  const origin = join(root, `${name}-origin.git`);
  const path = join(root, name);
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  mkdirSync(path);
  git(path, "init", "--quiet", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "remote", "add", "origin", origin);
  commit(path, "README.md");
  git(path, "push", "--quiet", "origin", "main");
  return { path, origin };
}

describe("repo routes", () => {
  it("scans a folder and registers each git repo", async () => {
    const paths = [gitRepo("a"), gitRepo("b"), gitRepo("c")];
    const scan = await request("/api/repos/scan", { method: "POST", body: { root } });
    expect(scan.status).toBe(200);
    const result = repoScanResultSchema.parse(await scan.json());
    expect(result.added.map((r) => r.path)).toEqual(paths);

    const list = repoViewSchema.array().parse(await (await request("/api/repos")).json());
    expect(list).toHaveLength(3);
    expect(list.every((r) => r.exists)).toBe(true);
  });

  it("adds, edits and deletes a repo", async () => {
    const add = await request("/api/repos", {
      method: "POST",
      body: { path: gitRepo("app"), checkCommands: ["make test"] },
    });
    expect(add.status).toBe(201);
    const repo = repoSchema.parse(await add.json());
    expect(repo.defaultCli).toBe("claude");
    expect(repo.defaultOrigin).toBe("jira-issue");
    expect(repo.maxBacklogTasks).toBeNull();

    const patch = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: {
        checkCommands: [],
        setupCommands: ["pnpm install --frozen-lockfile"],
        runCommands: ["pnpm dev"],
        defaultCli: "copilot",
        defaultOrigin: "free-text",
        maxBacklogTasks: 2,
      },
    });
    expect(repoSchema.parse(await patch.json())).toMatchObject({
      checkCommands: [],
      setupCommands: ["pnpm install --frozen-lockfile"],
      runCommands: ["pnpm dev"],
      defaultCli: "copilot",
      defaultOrigin: "free-text",
      maxBacklogTasks: 2,
    });
    const invalid = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { maxBacklogTasks: 0 },
    });
    expect(invalid.status).toBe(400);

    expect(repo.defaultBranch).toBe("main");
    const branch = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { defaultBranch: "develop" },
    });
    expect(repoSchema.parse(await branch.json()).defaultBranch).toBe("develop");
    const badBranch = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { defaultBranch: "-develop" },
    });
    expect(badBranch.status).toBe(400);

    expect(stopped).toEqual([]);
    expect((await request(`/api/repos/${repo.id}`, { method: "DELETE" })).status).toBe(204);
    expect(stopped).toEqual([repo.id]);
    expect((await request(`/api/repos/${repo.id}`)).status).toBe(404);
  });

  it("accepts and returns the agent trust level and the project MCP and hook flags", async () => {
    const add = await request("/api/repos", { method: "POST", body: { path: gitRepo("app") } });
    const repo = repoSchema.parse(await add.json());
    expect(repo).toMatchObject({
      agentTrust: "locked",
      trustProjectMcp: false,
      trustProjectHooks: false,
    });

    const patch = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { agentTrust: "trusted", trustProjectMcp: true, trustProjectHooks: true },
    });
    expect(patch.status).toBe(200);
    expect(repoSchema.parse(await patch.json())).toMatchObject({
      agentTrust: "trusted",
      trustProjectMcp: true,
      trustProjectHooks: true,
    });
    expect(repoSchema.parse(await (await request(`/api/repos/${repo.id}`)).json())).toMatchObject({
      agentTrust: "trusted",
      trustProjectMcp: true,
      trustProjectHooks: true,
    });

    const invalid = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { agentTrust: "wide-open" },
    });
    expect(invalid.status).toBe(400);
  });

  it("reorders repos and lists favourites first", async () => {
    gitRepo("a");
    gitRepo("b");
    gitRepo("c");
    await request("/api/repos/scan", { method: "POST", body: { root } });
    const listed = async () =>
      repoViewSchema
        .array()
        .parse(await (await request("/api/repos")).json())
        .map((r) => r.name);
    const [a, b, c] = repoViewSchema.array().parse(await (await request("/api/repos")).json());

    const res = await request("/api/repos/reorder", {
      method: "POST",
      body: { ids: [c!.id, a!.id, b!.id] },
    });
    expect(res.status).toBe(200);
    expect(
      repoViewSchema
        .array()
        .parse(await res.json())
        .map((r) => r.name),
    ).toEqual(["c", "a", "b"]);
    expect(await listed()).toEqual(["c", "a", "b"]);

    const partial = await request("/api/repos/reorder", {
      method: "POST",
      body: { ids: [a!.id, b!.id] },
    });
    expect(partial.status).toBe(400);
    expect(await partial.json()).toEqual({ error: "List every repo exactly once" });
    expect(
      (await request("/api/repos/reorder", { method: "POST", body: { ids: "a" } })).status,
    ).toBe(400);

    const patch = await request(`/api/repos/${b!.id}`, {
      method: "PATCH",
      body: { favorite: true },
    });
    expect(repoSchema.parse(await patch.json()).favorite).toBe(true);
    expect(await listed()).toEqual(["b", "c", "a"]);
  });

  it("rejects bad input", async () => {
    expect((await request("/api/repos", { method: "POST", body: {} })).status).toBe(400);
    const plain = join(root, "plain");
    mkdirSync(plain);
    const res = await request("/api/repos", { method: "POST", body: { path: plain } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `${plain} is not the root of a git repo` });
  });

  it("warns about a deleted repo folder when the repo is used and removes it", async () => {
    const path = gitRepo("app");
    const add = await request("/api/repos", { method: "POST", body: { path } });
    const repo = repoSchema.parse(await add.json());
    rmSync(path, { recursive: true, force: true });

    const res = await request(`/api/repos/${repo.id}/refresh`, { method: "POST" });
    expect(res.status).toBe(STALE_REPO_STATUS);
    const stale = staleRepoSchema.parse(await res.json());
    expect(stale).toMatchObject({ repoId: repo.id, path, removed: true });
    expect(stale.message).toContain("no longer exists");
    expect(await (await request("/api/repos")).json()).toEqual([]);
  });

  it("reads main's sync status", async () => {
    const plain = repoSchema.parse(
      await (
        await request("/api/repos", { method: "POST", body: { path: gitRepo("plain") } })
      ).json(),
    );
    const none = await request(`/api/repos/${plain.id}/sync`);
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();

    const { path } = clonedRepo("app");
    const repo = repoSchema.parse(
      await (await request("/api/repos", { method: "POST", body: { path } })).json(),
    );
    commit(path, "a.txt");
    const res = await request(`/api/repos/${repo.id}/sync`);
    expect(repoSyncSchema.parse(await res.json())).toEqual({ branch: "main", ahead: 1, behind: 0 });
  });

  it("pushes main, refusing when there is nothing to push", async () => {
    const { path, origin } = clonedRepo("app");
    const repo = repoSchema.parse(
      await (await request("/api/repos", { method: "POST", body: { path } })).json(),
    );
    const nothing = await request(`/api/repos/${repo.id}/push`, { method: "POST" });
    expect(nothing.status).toBe(400);
    expect(await nothing.json()).toEqual({ error: "Nothing to push" });

    const sha = commit(path, "a.txt");
    const res = await request(`/api/repos/${repo.id}/push`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(repoSyncSchema.parse(await res.json())).toEqual({ branch: "main", ahead: 0, behind: 0 });
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(sha);
  });

  it("answers 502 when git rejects the push", async () => {
    const { path, origin } = clonedRepo("app");
    const repo = repoSchema.parse(
      await (await request("/api/repos", { method: "POST", body: { path } })).json(),
    );
    writeFileSync(join(origin, "hooks", "pre-receive"), "#!/bin/sh\necho rejected >&2\nexit 1\n", {
      mode: 0o755,
    });
    commit(path, "a.txt");
    const res = await request(`/api/repos/${repo.id}/push`, { method: "POST" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("rejected");
  });
});

describe("repo rename route", () => {
  let renameApp: Hono;
  let repositories: ReturnType<typeof createRepositories>;
  let events: ServerEvent[];
  let renamed: string[];

  beforeEach(() => {
    events = [];
    renamed = [];
    repositories = createRepositories(opened.db);
    const tokens = createConnectionTokens({
      store: createMemorySecretStore(),
      connections: repositories.connections,
      env: {},
    });
    const connections = createConnectionService({ connections: repositories.connections, tokens });
    repositories.connections.create({
      name: "github.com",
      kind: "github",
      baseUrl: "https://github.com",
    });
    let current = "app";
    const repos = createRepoService({
      repos: repositories.repos,
      connections,
      rename: {
        tasks: repositories.tasks,
        transaction: repositories.transaction,
        busyTaskIds: () => [],
        backfillRunning: () => false,
        locks: createRepoRenameLocks(),
        github: {
          currentName: () => Promise.resolve(current),
          renameRepo: (_remote, name) => {
            renamed.push(name);
            current = name;
            return Promise.resolve();
          },
        },
      },
    });
    renameApp = new Hono()
      .onError(errorResponse)
      .route("/api/repos", repoRoutes(repos, { broadcast: (event) => events.push(event) }));
  });

  function rename(id: string, body: unknown) {
    return renameApp.request(`http://localhost/api/repos/${id}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function registered(withTask: boolean) {
    const path = gitRepo("app");
    git(path, "remote", "add", "origin", "git@github.com:acme/app.git");
    git(path, "config", "user.name", "Test");
    git(path, "config", "user.email", "test@example.com");
    git(path, "config", "commit.gpgsign", "false");
    commit(path, "README.md");
    const repo = repositories.repos.create({
      path,
      name: "app",
      remoteUrl: "git@github.com:acme/app.git",
    });
    if (!withTask) return { repo, task: undefined };
    const task = repositories.tasks.create({
      title: "t1",
      origin: { kind: "free-text" },
      repoId: repo.id,
    });
    const worktree = join(root, "app.worktrees", task.id);
    git(path, "worktree", "add", "--quiet", "-b", `task-${task.id}`, worktree);
    const ready = repositories.tasks.update(task.id, {
      worktreePath: worktree,
      status: "needs-you",
    });
    return { repo, task: ready };
  }

  it("rejects an invalid name", async () => {
    const { repo } = await registered(false);
    expect((await rename(repo.id, { name: "x.git" })).status).toBe(400);
    expect((await rename(repo.id, {})).status).toBe(400);
    expect(renamed).toEqual([]);
  });

  it("is a conflict while a task in the repo runs", async () => {
    const { repo, task } = await registered(true);
    repositories.tasks.update(task!.id, { status: "running" });
    const res = await rename(repo.id, { name: "shop" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("t1");
    expect(renamed).toEqual([]);
  });

  it("renames, returns the result without secrets and broadcasts moved tasks", async () => {
    const { repo, task } = await registered(true);
    const res = await rename(repo.id, { name: "shop" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/token/i);
    const result = repoRenameResultSchema.parse(JSON.parse(text));
    expect(result).toMatchObject({
      completed: ["github", "origin", "folder", "records"],
      failed: null,
      repo: { name: "shop", path: join(root, "shop") },
    });
    expect(renamed).toEqual(["shop"]);
    const moved = repositories.tasks.get(task!.id)!;
    expect(moved.worktreePath).toBe(join(root, "shop.worktrees", task!.id));
    expect(events).toEqual([{ type: "task.upserted", payload: { task: moved } }]);
  });
});
