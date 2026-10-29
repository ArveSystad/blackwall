import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { createMemoryReleaser, type PullRequestMergeState } from "./memory-release.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-memory-release-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const prOrigin = (number: number) => ({
  kind: "github-pr" as const,
  url: `https://github.com/acme/app/pull/${number}`,
  owner: "acme",
  repo: "app",
  number,
  connectionId: null,
});

function repo() {
  return (
    r.repos.getByPath("/code/app") ??
    r.repos.create({ path: "/code/app", name: "app", defaultBranch: "develop" })
  );
}

/** A PR task with one held note per text. */
function heldTask(number: number, ...texts: string[]): Task {
  const task = r.tasks.create({
    title: `PR ${number}`,
    origin: prOrigin(number),
    mode: "work",
    repoId: repo().id,
  });
  r.memories.replaceForTask(
    task.id,
    task.repoId,
    texts.map((text) => ({ kind: "convention", text })),
    { awaitingMerge: true },
  );
  return task;
}

const open: PullRequestMergeState = { state: "open", merged: false, baseRef: "develop" };
const merged = (baseRef = "develop"): PullRequestMergeState => ({
  state: "closed",
  merged: true,
  baseRef,
});

const active = () =>
  r.memories
    .listByRepo(repo().id)
    .map((m) => m.text)
    .sort();
const held = () =>
  opened.db.$client
    .prepare("SELECT text FROM memories WHERE awaiting_merge = 1 ORDER BY text")
    .pluck()
    .all();

function releaser(
  states: Record<number, PullRequestMergeState | Error>,
  log: (message: string) => void = () => undefined,
) {
  const prMergeState = vi.fn(async (task: Task) => {
    const state = states[task.origin.kind === "github-pr" ? task.origin.number : -1];
    if (!state || state instanceof Error) throw state ?? new Error("unknown PR");
    return state;
  });
  return { prMergeState, releaser: createMemoryReleaser({ repositories: r, prMergeState, log }) };
}

describe("createMemoryReleaser", () => {
  it("releases notes once the PR merges into the repo's default branch", async () => {
    heldTask(1, "Use the login helper");
    await releaser({ 1: merged() }).releaser.check();
    expect(active()).toEqual(["Use the login helper"]);
    expect(r.memories.relevant(repo().id, "login helper").map((m) => m.text)).toEqual([
      "Use the login helper",
    ]);
    expect(r.memories.tasksAwaitingMerge()).toEqual([]);
  });

  it("discards notes when the PR merges elsewhere or closes unmerged", async () => {
    heldTask(1, "Merged elsewhere");
    heldTask(2, "Closed unmerged");
    await releaser({
      1: merged("feature/base"),
      2: { state: "closed", merged: false, baseRef: "develop" },
    }).releaser.check();
    expect(active()).toEqual([]);
    expect(held()).toEqual([]);
  });

  it("keeps notes of an open PR and checks them again on the next pass", async () => {
    heldTask(1, "Still open");
    const states: Record<number, PullRequestMergeState> = { 1: open };
    const { releaser: rel, prMergeState } = releaser(states);
    await rel.check();
    expect(held()).toEqual(["Still open"]);
    states[1] = merged();
    await rel.check();
    expect(prMergeState).toHaveBeenCalledTimes(2);
    expect(active()).toEqual(["Still open"]);
  });

  it("keeps notes and logs when the check fails, and goes on with the other tasks", async () => {
    heldTask(1, "No token");
    heldTask(2, "Merged fine");
    const log = vi.fn();
    await releaser({ 1: new Error("no token"), 2: merged() }, log).releaser.check();
    expect(held()).toEqual(["No token"]);
    expect(active()).toEqual(["Merged fine"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no token"));
  });

  it("discards notes whose task was deleted or is not a PR, without asking GitHub", async () => {
    const deleted = heldTask(1, "Task deleted");
    r.tasks.delete(deleted.id);
    const free = r.tasks.create({
      title: "Free",
      origin: { kind: "free-text" },
      repoId: repo().id,
    });
    r.memories.replaceForTask(free.id, free.repoId, [{ kind: "context", text: "Not a PR" }], {
      awaitingMerge: true,
    });
    const { releaser: rel, prMergeState } = releaser({});
    await rel.check();
    expect(prMergeState).not.toHaveBeenCalled();
    expect(held()).toEqual([]);
  });

  it("drops a released note that duplicates an active one", async () => {
    r.memories.create({ repoId: repo().id, kind: "convention", text: "Use pnpm" });
    heldTask(1, "use PNPM ", "Run codegen first");
    await releaser({ 1: merged() }).releaser.check();
    expect(active()).toEqual(["Run codegen first", "Use pnpm"]);
  });

  describe("onChanged", () => {
    function watched(states: Record<number, PullRequestMergeState | Error>) {
      const onChanged = vi.fn();
      const prMergeState = async (task: Task) => {
        const state = states[task.origin.kind === "github-pr" ? task.origin.number : -1];
        if (!state || state instanceof Error) throw state ?? new Error("unknown PR");
        return state;
      };
      const rel = createMemoryReleaser({
        repositories: r,
        prMergeState,
        log: () => undefined,
        onChanged,
      });
      return { onChanged, check: () => rel.check() };
    }

    it("hears of the repo when a merged PR releases its notes", async () => {
      heldTask(1, "Released");
      const { onChanged, check } = watched({ 1: merged() });
      await check();
      expect(onChanged.mock.calls).toEqual([[repo().id]]);
    });

    it("hears of the repo when a closed PR discards its notes", async () => {
      heldTask(1, "Discarded");
      const { onChanged, check } = watched({
        1: { state: "closed", merged: false, baseRef: "develop" },
      });
      await check();
      expect(onChanged.mock.calls).toEqual([[repo().id]]);
    });

    it("hears of the repo when notes whose task was deleted are discarded", async () => {
      r.tasks.delete(heldTask(1, "Orphan").id);
      const { onChanged, check } = watched({});
      await check();
      expect(onChanged.mock.calls).toEqual([[repo().id]]);
    });

    it("stays quiet while the PR is open or its check fails", async () => {
      heldTask(1, "Open");
      heldTask(2, "Unknown");
      const { onChanged, check } = watched({ 1: open, 2: new Error("no token") });
      await check();
      expect(onChanged).not.toHaveBeenCalled();
    });
  });

  it("runs one pass for concurrent checks", async () => {
    heldTask(1, "Once");
    const { releaser: rel, prMergeState } = releaser({ 1: open });
    await Promise.all([rel.check(), rel.check()]);
    expect(prMergeState).toHaveBeenCalledTimes(1);
  });

  it("checks at start and on each tick until stopped, aborting a pass in flight", async () => {
    vi.useFakeTimers();
    try {
      heldTask(1, "Ticked");
      let signal: AbortSignal | undefined;
      const prMergeState = vi.fn(async (_task: Task, s: AbortSignal) => {
        signal = s;
        return open;
      });
      const rel = createMemoryReleaser({ repositories: r, prMergeState, intervalMs: 1000 });
      rel.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(prMergeState).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(prMergeState).toHaveBeenCalledTimes(2);
      rel.stop();
      expect(signal?.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(prMergeState).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
