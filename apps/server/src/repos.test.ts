import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConnectionService,
  createConnectionTokens,
  createMemorySecretStore,
  createRepoService,
  createRepositories,
  openDatabase,
  type OpenedDatabase,
} from "@blackwall/core";
import {
  STALE_REPO_STATUS,
  repoScanResultSchema,
  repoSchema,
  repoViewSchema,
  staleRepoSchema,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { tokenCookieName } from "./auth.js";

const launchToken = "test-token";
const port = 4711;
const host = `127.0.0.1:${port}`;
const cookie = `${tokenCookieName(port)}=${launchToken}`;

let opened: OpenedDatabase;
let root: string;
let app: ReturnType<typeof createApp>["app"];

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
  app = createApp({ token: launchToken, getPort: () => port, repos }).app;
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

    const patch = await request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      body: { checkCommands: [], defaultCli: "copilot", defaultOrigin: "free-text" },
    });
    expect(repoSchema.parse(await patch.json())).toMatchObject({
      checkCommands: [],
      defaultCli: "copilot",
      defaultOrigin: "free-text",
    });

    expect((await request(`/api/repos/${repo.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request(`/api/repos/${repo.id}`)).status).toBe(404);
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
});
