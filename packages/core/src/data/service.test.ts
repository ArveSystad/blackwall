import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemorySecretStore, type SecretStore } from "../secrets/secret-store.js";
import { createConnectionTokens } from "../secrets/tokens.js";
import { sqliteOf } from "./archive.js";
import { DataImportBusyError, createDataService } from "./service.js";

let root: string;
let opened: OpenedDatabase[];
let source: Repositories;
let archive: Uint8Array;
let live: Repositories;
let liveDir: string;
let store: SecretStore;
let events: ServerEvent[];
let calls: string[];
let engineIds: { active: string[]; queued: string[] };
let afterPause: () => void;

function open(name: string) {
  const dir = join(root, name);
  const o = openDatabase(dir);
  opened.push(o);
  return { o, r: createRepositories(o.db), dir };
}

function service(r: Repositories, o: OpenedDatabase, dir: string) {
  const tokens = createConnectionTokens({ store, connections: r.connections, env: {} });
  return createDataService({
    sqlite: sqliteOf(o.db),
    dataDir: dir,
    repositories: r,
    pipeline: {
      activeTaskIds: () => engineIds.active,
      queuedTaskIds: () => engineIds.queued,
    },
    tokens,
    pause: async () => {
      calls.push("pause");
      afterPause();
    },
    resume: () => calls.push("resume"),
    publish: (event) => events.push(event),
    version: "1.0.0",
    clock: () => new Date("2026-10-14T12:00:00.000Z"),
    pathExists: (path) => path.startsWith("/exists"),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blackwall-data-"));
  opened = [];
  store = createMemorySecretStore();
  events = [];
  calls = [];
  engineIds = { active: [], queued: [] };
  afterPause = () => undefined;

  const src = open("source");
  source = src.r;
  const kept = source.connections.create({
    name: "github.com",
    kind: "github",
    baseUrl: "https://api.github.com",
    tokenSet: true,
  });
  source.connections.create({
    name: "jira",
    kind: "jira",
    baseUrl: "https://acme.atlassian.net",
    tokenSet: true,
  });
  const present = source.repos.create({ path: "/exists/app", name: "app" });
  source.repos.create({ path: "/gone/lib", name: "lib" });
  source.tasks.create({
    title: "Has worktree",
    origin: { kind: "free-text" },
    repoId: present.id,
    status: "needs-you",
    worktreePath: "/exists/app.worktrees/a",
  });
  source.tasks.create({
    title: "Lost worktree",
    origin: { kind: "free-text" },
    repoId: present.id,
    status: "done",
    worktreePath: "/gone/app.worktrees/b",
  });
  archive = service(source, src.o, src.dir).export({ includeTranscripts: true });
  // Same machine: this keychain already holds the GitHub token.
  void store.set(kept.id, "ghp_token");

  const target = open("target");
  live = target.r;
  liveDir = target.dir;
  live.repos.create({ path: "/exists/before", name: "before" });
});

afterEach(() => {
  for (const o of opened) o.close();
  rmSync(root, { recursive: true, force: true });
});

function liveService() {
  return service(live, opened[1]!, liveDir);
}

describe("data service", () => {
  it("imports in place, backs up first and reports what needs attention", async () => {
    const result = await liveService().import(archive);

    expect(calls).toEqual(["pause", "resume"]);
    expect(events).toEqual([{ type: "data.imported", payload: {} }]);
    expect(existsSync(result.backupPath)).toBe(true);
    expect(result.backupPath.startsWith(join(liveDir, "backups"))).toBe(true);
    expect(result.manifest.blackwallVersion).toBe("1.0.0");
    expect(live.repos.list().map((r) => r.name)).toEqual(["app", "lib"]);

    // The keychain had the GitHub token, not the Jira one.
    expect(result.connectionsMissingToken.map((c) => c.name)).toEqual(["jira"]);
    expect(live.connections.list().find((c) => c.name === "github.com")?.tokenSet).toBe(true);
    expect(result.missingRepos).toEqual([
      expect.objectContaining({ name: "lib", path: "/gone/lib" }),
    ]);
    expect(result.tasksMissingWorktree).toEqual([
      expect.objectContaining({ title: "Lost worktree", path: "/gone/app.worktrees/b" }),
    ]);
  });

  it.each([
    ["running", { status: "running" as const }],
    ["queued", { status: "queued" as const }],
    ["delivering", { status: "needs-you" as const, delivering: true }],
  ])("refuses while a task is %s and leaves the data alone", async (_label, values) => {
    const repoId = live.repos.list()[0]!.id;
    live.tasks.create({ title: "Busy one", origin: { kind: "free-text" }, repoId, ...values });

    await expect(liveService().import(archive)).rejects.toThrow(DataImportBusyError);
    await expect(liveService().import(archive)).rejects.toThrow("Busy one");
    expect(calls).toEqual([]);
    expect(events).toEqual([]);
    expect(live.repos.list().map((r) => r.name)).toEqual(["before"]);
  });

  it("refuses while the engine holds a task", async () => {
    engineIds.queued = ["t-queued"];
    await expect(liveService().import(archive)).rejects.toThrow(DataImportBusyError);
    expect(live.repos.list().map((r) => r.name)).toEqual(["before"]);
  });

  it("refuses when a task starts while pausing, and resumes", async () => {
    afterPause = () => {
      engineIds.active = ["t-late"];
    };
    await expect(liveService().import(archive)).rejects.toThrow(DataImportBusyError);
    expect(calls).toEqual(["pause", "resume"]);
    expect(events).toEqual([]);
    expect(live.repos.list().map((r) => r.name)).toEqual(["before"]);
    expect(existsSync(join(liveDir, "backups"))).toBe(false);
  });
});
