import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ciMissingTokenHint,
  ciScopeHint,
  ciSsoHint,
  type CiCheck,
  type ServerEvent,
  type Task,
  type TaskCi,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import {
  BACKOFF_FACTOR,
  CiRateLimitedError,
  FIRST_POLL_MS,
  MAX_CI_FAILURES,
  MAX_POLL_MS,
  NO_CHECKS_GRACE_MS,
  RATE_LIMIT_RETRY_MS,
  WATCH_CAP_MS,
  createCiWatcher,
  type CiPorts,
  type CiReadResult,
} from "./ci.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-ci-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

const SHA = "abc1234def5678";
const START = Date.parse("2026-10-14T10:00:00.000Z");
const GITHUB_REMOTE = "https://github.com/acme/app.git";

const check = (name: string, state: CiCheck["state"], id = name.length): CiCheck => ({
  name,
  kind: "check-run",
  id,
  state,
  conclusion: state === "failed" ? "failure" : state === "passed" ? "success" : null,
  url: `https://github.com/acme/app/runs/${id}`,
});

const read = (checks: CiCheck[], extra: Partial<CiReadResult> = {}): CiReadResult => ({
  checks,
  unreadable: [],
  ...extra,
});

function seedTask(repoPatch: { watchCi?: boolean } = {}, patch: Partial<Task> = {}): Task {
  const repo = r.repos.create({ path: `/code/app-${Math.random()}`, name: "app", ...repoPatch });
  return r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    branch: "feature/x",
    worktreePath: "/code/app/.worktrees/x",
    ...patch,
  });
}

/** A step of the fake `readChecks`: a result, or an error it throws. */
type Poll = CiReadResult | Error;

/**
 * A watcher on a fake clock: `sleep` advances it and records each wait;
 * `readChecks` answers with `polls` in order, repeating the last one.
 */
function harness(
  polls: Poll[] = [read([check("test", "passed")])],
  {
    remote = GITHUB_REMOTE,
    logTail = async () => "FAIL expected 401",
    sleep,
  }: {
    remote?: string | null;
    logTail?: CiPorts["logTail"];
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  let clock = START;
  const sleeps: number[] = [];
  const events: ServerEvent[] = [];
  let index = 0;
  const readChecks = vi.fn(async (): Promise<CiReadResult> => {
    const poll = polls[Math.min(index++, polls.length - 1)]!;
    if (poll instanceof Error) throw poll;
    return poll;
  });
  const ports = { readChecks, logTail: vi.fn(logTail) };
  const watcher = createCiWatcher({
    repositories: r,
    git: { headSha: async () => SHA, remoteUrl: async () => remote },
    parseRemote: (url) =>
      url.startsWith("https://github.com/")
        ? { host: "github.com", owner: "acme", repo: "app" }
        : undefined,
    ports,
    publish: (event) => events.push(event),
    sleep:
      sleep ??
      (async (ms) => {
        sleeps.push(ms);
        clock += ms;
      }),
    now: () => new Date(clock),
    log: () => undefined,
  });
  return {
    watcher,
    ports,
    sleeps,
    events,
    elapsed: () => clock - START,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const ciOf = (id: string) => r.tasks.get(id)!.ci;

/** The `ci` of each task.upserted the watcher published, in order. */
const published = (events: ServerEvent[]) =>
  events.flatMap((e) => (e.type === "task.upserted" ? [e.payload.task.ci] : []));

describe("CI watcher", () => {
  it("polls until every check passes, then stops", async () => {
    const h = harness([read([check("test", "pending")]), read([check("test", "passed")])]);
    const task = seedTask();
    await h.watcher.watch(task.id);

    expect(h.ports.readChecks).toHaveBeenCalledTimes(2);
    expect(h.ports.readChecks.mock.calls[0]![0]).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "app",
      sha: SHA,
    });
    expect(h.sleeps).toEqual([FIRST_POLL_MS, FIRST_POLL_MS * BACKOFF_FACTOR]);
    expect(ciOf(task.id)).toMatchObject({
      state: "passed",
      sha: SHA,
      host: "github.com",
      owner: "acme",
      repo: "app",
      hint: null,
      startedAt: new Date(START).toISOString(),
      finishedAt: new Date(START + h.elapsed()).toISOString(),
    });
    expect(published(h.events).map((ci) => ci?.state)).toEqual(["pending", "pending", "passed"]);
  });

  it("reports a failure with the failing checks' names and links", async () => {
    const h = harness([read([check("lint", "passed"), check("test", "failed", 7)])]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    const ci = ciOf(task.id)!;
    expect(ci.state).toBe("failed");
    expect(ci.finishedAt).not.toBeNull();
    expect(ci.checks.filter((c) => c.state === "failed")).toEqual([
      expect.objectContaining({ name: "test", url: "https://github.com/acme/app/runs/7" }),
    ]);
  });

  it("shows a failure at once and keeps polling until the rest complete", async () => {
    const h = harness([
      read([check("test", "failed"), check("e2e", "pending")]),
      read([check("test", "failed"), check("e2e", "passed")]),
    ]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    const states = published(h.events).map((ci) => [ci?.state, ci?.finishedAt === null]);
    expect(states).toEqual([
      ["pending", true],
      ["failed", true],
      ["failed", false],
    ]);
  });

  it("times out when checks are still pending after the cap", async () => {
    const h = harness([read([check("test", "pending")])]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({ state: "timed-out" });
    expect(h.elapsed()).toBe(WATCH_CAP_MS);
  });

  it("backs off by the factor up to the longest wait", async () => {
    const h = harness([read([check("test", "pending")])]);
    await h.watcher.watch(seedTask().id);
    const expected = [FIRST_POLL_MS];
    while (expected.length < 8) {
      expected.push(Math.min(Math.round(expected.at(-1)! * BACKOFF_FACTOR), MAX_POLL_MS));
    }
    expect(h.sleeps.slice(0, 8)).toEqual(expected);
    expect(Math.max(...h.sleeps)).toBe(MAX_POLL_MS);
  });

  it("reports no CI when no checks appear within the grace period", async () => {
    const h = harness([read([])]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({ state: "none", checks: [] });
    expect(h.elapsed()).toBeGreaterThanOrEqual(NO_CHECKS_GRACE_MS);
    expect(h.elapsed()).toBeLessThan(NO_CHECKS_GRACE_MS + MAX_POLL_MS);
  });

  it("is unavailable with the scope hint when the token can't read check runs", async () => {
    const h = harness([read([], { unreadable: [{ source: "check-runs", reason: "scope" }] })]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({ state: "unavailable", hint: ciScopeHint("github.com") });
    expect(h.ports.readChecks).toHaveBeenCalledOnce();
  });

  it("is unavailable with the SSO hint when the token isn't authorised for SSO", async () => {
    const h = harness([
      read([], {
        unreadable: [
          { source: "check-runs", reason: "sso" },
          { source: "statuses", reason: "sso" },
        ],
      }),
    ]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({ state: "unavailable", hint: ciSsoHint("github.com") });
  });

  it("is unavailable with a hint when there is no token for the host", async () => {
    const h = harness([read([], { missingToken: true })]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({
      state: "unavailable",
      hint: ciMissingTokenHint("github.com"),
    });
  });

  it("keeps watching with the hint when only statuses are unreadable", async () => {
    const statuses = { unreadable: [{ source: "statuses" as const, reason: "scope" as const }] };
    const h = harness([
      read([check("test", "pending")], statuses),
      read([check("test", "passed")], statuses),
    ]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(ciOf(task.id)).toMatchObject({ state: "passed", hint: ciScopeHint("github.com") });
  });

  describe("rate limits", () => {
    const limited = () => new CiRateLimitedError();

    it("retries after a fixed wait without moving the backoff or the stored state", async () => {
      const h = harness([
        read([check("test", "pending")]),
        limited(),
        read([check("test", "pending")]),
        read([check("test", "passed")]),
      ]);
      const task = seedTask();
      await h.watcher.watch(task.id);
      expect(h.sleeps).toEqual([
        FIRST_POLL_MS,
        FIRST_POLL_MS * BACKOFF_FACTOR,
        RATE_LIMIT_RETRY_MS,
        FIRST_POLL_MS * BACKOFF_FACTOR ** 2,
      ]);
      // The rate-limited poll wrote nothing and set no hint.
      expect(published(h.events).map((ci) => ci?.state)).toEqual([
        "pending",
        "pending",
        "pending",
        "passed",
      ]);
      expect(published(h.events).every((ci) => ci?.hint === null)).toBe(true);
    });

    it("keeps retrying every few seconds until a poll succeeds", async () => {
      const h = harness([
        limited(),
        limited(),
        limited(),
        limited(),
        read([check("test", "passed")]),
      ]);
      const task = seedTask();
      await h.watcher.watch(task.id);
      expect(h.sleeps).toEqual([
        FIRST_POLL_MS,
        RATE_LIMIT_RETRY_MS,
        RATE_LIMIT_RETRY_MS,
        RATE_LIMIT_RETRY_MS,
        RATE_LIMIT_RETRY_MS,
      ]);
      expect(ciOf(task.id)).toMatchObject({ state: "passed", hint: null });
    });

    it("times out when the rate limit lasts past the cap", async () => {
      const h = harness([limited()]);
      const task = seedTask();
      await h.watcher.watch(task.id);
      expect(ciOf(task.id)).toMatchObject({ state: "timed-out", hint: null });
      expect(h.elapsed()).toBe(WATCH_CAP_MS);
      expect(new Set(h.sleeps.slice(1, -1))).toEqual(new Set([RATE_LIMIT_RETRY_MS]));
    });
  });

  it("keeps polling at the backoff step after other errors", async () => {
    const h = harness([
      new Error("could not connect"),
      new Error("unexpected response 502"),
      read([check("test", "passed")]),
    ]);
    const task = seedTask();
    await h.watcher.watch(task.id);
    expect(h.sleeps).toEqual([
      FIRST_POLL_MS,
      FIRST_POLL_MS * BACKOFF_FACTOR,
      FIRST_POLL_MS * BACKOFF_FACTOR ** 2,
    ]);
    expect(ciOf(task.id)).toMatchObject({ state: "passed" });
  });

  it("clears CI without polling when the repo doesn't watch it or the remote isn't GitHub", async () => {
    const earlier: TaskCi = {
      state: "failed",
      sha: "old",
      host: "github.com",
      owner: "acme",
      repo: "app",
      checks: [],
      hint: null,
      startedAt: new Date(START).toISOString(),
      updatedAt: new Date(START).toISOString(),
      finishedAt: new Date(START).toISOString(),
    };
    const off = harness();
    const unwatched = seedTask({ watchCi: false }, { ci: earlier });
    await off.watcher.watch(unwatched.id);
    expect(ciOf(unwatched.id)).toBeNull();
    expect(off.ports.readChecks).not.toHaveBeenCalled();

    const gitlab = harness(undefined, { remote: "https://gitlab.com/acme/app.git" });
    const other = seedTask({}, { ci: earlier });
    await gitlab.watcher.watch(other.id);
    expect(ciOf(other.id)).toBeNull();
    expect(gitlab.ports.readChecks).not.toHaveBeenCalled();
  });

  it("resumes pending watches on recovery and times out those past the cap", async () => {
    const h = harness([read([check("test", "passed")])]);
    const pending = (startedAt: number): TaskCi => ({
      state: "pending",
      sha: SHA,
      host: "github.com",
      owner: "acme",
      repo: "app",
      checks: [],
      hint: null,
      startedAt: new Date(startedAt).toISOString(),
      updatedAt: new Date(startedAt).toISOString(),
      finishedAt: null,
    });
    const fresh = seedTask({}, { ci: pending(START - 10 * 60_000) });
    const stale = seedTask({}, { ci: pending(START - WATCH_CAP_MS) });
    const done = seedTask({}, { ci: { ...pending(START), state: "passed" } });

    await h.watcher.recover();
    expect(ciOf(fresh.id)).toMatchObject({ state: "passed", sha: SHA });
    expect(ciOf(stale.id)).toMatchObject({ state: "timed-out" });
    expect(ciOf(done.id)).toMatchObject({ state: "passed", finishedAt: null });
    expect(h.ports.readChecks).toHaveBeenCalledOnce();
  });

  it("stops a watch on cancel and on stop, leaving its state as it is", async () => {
    const waitForAbort = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    const h = harness(undefined, { sleep: waitForAbort });
    const cancelled = seedTask();
    const stopped = seedTask();

    const first = h.watcher.watch(cancelled.id);
    const second = h.watcher.watch(stopped.id);
    await vi.waitFor(() => {
      expect(ciOf(cancelled.id)?.state).toBe("pending");
      expect(ciOf(stopped.id)?.state).toBe("pending");
    });
    h.watcher.cancel(cancelled.id);
    await first;
    h.watcher.stop();
    await second;

    expect(h.ports.readChecks).not.toHaveBeenCalled();
    expect(ciOf(cancelled.id)?.state).toBe("pending");
    expect(ciOf(stopped.id)?.state).toBe("pending");
  });

  it("replaces an earlier watch of the same task", async () => {
    const waitForAbort = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    const h = harness(undefined, { sleep: waitForAbort });
    const task = seedTask();
    const first = h.watcher.watch(task.id);
    await vi.waitFor(() => expect(ciOf(task.id)?.state).toBe("pending"));
    const second = h.watcher.watch(task.id);
    await first;
    h.watcher.stop();
    await second;
    expect(h.ports.readChecks).not.toHaveBeenCalled();
  });

  describe("failureContext", () => {
    const failedTask = (checks: CiCheck[]): Task =>
      ({
        ...seedTask(),
        ci: {
          state: "failed",
          sha: SHA,
          host: "github.com",
          owner: "acme",
          repo: "app",
          checks,
          hint: null,
          startedAt: new Date(START).toISOString(),
          updatedAt: new Date(START).toISOString(),
          finishedAt: new Date(START).toISOString(),
        },
      }) satisfies Task;

    it("returns the failing checks with their log tails", async () => {
      const h = harness();
      const task = failedTask([check("lint", "passed", 1), check("test", "failed", 2)]);
      const failures = await h.watcher.failureContext(task);
      expect(failures).toEqual([{ check: task.ci!.checks[1], log: "FAIL expected 401" }]);
      expect(h.ports.logTail).toHaveBeenCalledWith(
        { host: "github.com", owner: "acme", repo: "app", sha: SHA },
        task.ci!.checks[1],
        expect.any(AbortSignal),
      );
    });

    it("leaves out logs it can't fetch and caps the failures", async () => {
      const h = harness(undefined, {
        logTail: async (_target, c) => {
          if (c.id === 0) throw new Error("403");
          return `log ${c.id}`;
        },
      });
      const checks = Array.from({ length: MAX_CI_FAILURES + 3 }, (_, i) =>
        check(`job ${i}`, "failed", i),
      );
      const failures = await h.watcher.failureContext(failedTask(checks));
      expect(failures).toHaveLength(MAX_CI_FAILURES);
      expect(failures[0]).toEqual({ check: checks[0], log: undefined });
      expect(failures[1]).toEqual({ check: checks[1], log: "log 1" });
    });

    it("returns nothing for a task without CI", async () => {
      const h = harness();
      expect(await h.watcher.failureContext(seedTask())).toEqual([]);
    });
  });
});
