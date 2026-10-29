import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliveryConfirmationSchema,
  type DeliveryConfirmationInput,
  type Run,
  type Task,
} from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingCredentialError } from "../connections/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { worktreePathFor } from "../git/branches.js";
import { GitError, createGitService } from "../git/service.js";
import * as deliveryModule from "./delivery.js";
import {
  DELIVERY_EVENT_TYPES,
  DeliveryError,
  createDeliverer,
  type DeliveryContext,
  type DeliveryOutcome,
  type DeliveryPorts,
  type DeliveryStep,
} from "./delivery.js";
import { InvalidGateResponseError } from "./transitions.js";

let root: string;
let repoPath: string;
let originPath: string;
let opened: OpenedDatabase;
let r: Repositories;
const git = createGitService();

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function commit(dir: string, file: string, content: string, message = `edit ${file}`): void {
  writeFileSync(join(dir, file), content);
  run(dir, "add", "-A");
  run(dir, "commit", "--quiet", "-m", message);
}

const subjects = (dir: string, ref = "HEAD") => run(dir, "log", "--format=%s", ref).split("\n");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "blackwall-delivery-")));
  originPath = join(root, "origin.git");
  repoPath = join(root, "app");
  run(root, "init", "--quiet", "--bare", "-b", "main", originPath);
  mkdirSync(repoPath);
  run(repoPath, "init", "--quiet", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ] as const) {
    run(repoPath, "config", key, value);
  }
  run(repoPath, "remote", "add", "origin", originPath);
  commit(repoPath, "README.md", "hello\n", "initial");
  run(repoPath, "push", "--quiet", "origin", "main");
  opened = openDatabase(join(root, "data"));
  r = createRepositories(opened.db);
});

afterEach(() => {
  opened.close();
  rmSync(root, { recursive: true, force: true });
});

function fakePorts(overrides: Partial<DeliveryPorts> = {}) {
  return {
    parseRemote: vi.fn((url: string) =>
      url.startsWith("https://github.com/")
        ? { host: "github.com", owner: "acme", repo: "app" }
        : undefined,
    ),
    jiraIssueUrl: vi.fn(() => "https://acme.atlassian.net/browse/ABC-1"),
    openPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/app/pull/8" })),
    commentOnPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/app/pull/7#c1" })),
    commentOnJiraIssue: vi.fn(async () => ({ url: "https://acme.atlassian.net/browse/ABC-1" })),
    commentOnGitHubIssue: vi.fn(async () => ({
      url: "https://github.com/acme/app/issues/7#issuecomment-1",
    })),
    reviewPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/app/pull/7#r1" })),
    ...overrides,
  } satisfies DeliveryPorts;
}

/** Has origin report `url` while pushes still land in the local bare repo. */
function fakeOrigin(url: string): void {
  run(repoPath, "remote", "set-url", "origin", url);
  run(repoPath, "remote", "set-url", "--push", "origin", originPath);
}

/**
 * A task with its worktree on `branch`, and `commits` commits made on it.
 * `remoteUrl` is what the repo row caches and, unless `null`, what origin reports.
 */
async function seed(
  patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> & { branch: string },
  {
    commits = 2,
    remoteUrl = originPath,
    existing = false,
  }: { commits?: number; remoteUrl?: string | null; existing?: boolean } = {},
): Promise<{ task: Task; run: Run }> {
  const repo =
    r.repos.getByPath(repoPath) ?? r.repos.create({ path: repoPath, name: "app", remoteUrl });
  if (remoteUrl !== null && remoteUrl !== originPath) fakeOrigin(remoteUrl);
  const created = r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    summary: "Compared passwords strictly.",
    shortSummary: "Logins reject wrong passwords.",
    squashMessage: "Fix login",
    ...patch,
  });
  const worktreePath = worktreePathFor(repoPath, created.id);
  await git.createWorktree({
    repoPath,
    worktreePath,
    branch: patch.branch,
    checkout: existing ? { kind: "existing", fetch: true } : { kind: "new" },
  });
  for (let i = 0; i < commits; i += 1) commit(worktreePath, `f${i}.txt`, `${i}\n`);
  const task = r.tasks.update(created.id, { worktreePath });
  return { task, run: r.runs.create(task.id) };
}

function deliverer(ports = fakePorts(), onBacklogChanged?: (repoId: string) => void) {
  return {
    ports,
    deliverer: createDeliverer({
      git,
      repositories: r,
      ports,
      ...(onBacklogChanged ? { onBacklogChanged } : {}),
    }),
  };
}

async function deliver(
  d: ReturnType<typeof createDeliverer>,
  task: Task,
  runRow: Run,
  confirmation: DeliveryConfirmationInput,
  completed: DeliveryStep[] = [],
  resolveConflicts: DeliveryContext["resolveConflicts"] = () =>
    Promise.reject(new Error("no resolver")),
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  await d.deliver({
    task,
    run: runRow,
    confirmation: deliveryConfirmationSchema.parse(confirmation),
    completed,
    record: (o) => outcomes.push(o),
    resolveConflicts,
  });
  return outcomes;
}

describe("delivery event types", () => {
  it("lists every delivery event", () => {
    const events = Object.entries(deliveryModule)
      .filter(([name]) => /^DELIVERY_.*_EVENT$/.test(name))
      .map(([, type]) => type);
    expect(events).not.toHaveLength(0);
    expect(DELIVERY_EVENT_TYPES).toEqual(expect.arrayContaining(events));
  });
});

describe("free-text tasks", () => {
  it("offers the local merge and a squash, and never a push", async () => {
    const { task } = await seed({ branch: "agent/t1" });
    const { deliverer: d } = deliverer();
    const plan = await d.plan(task, []);
    expect(plan.actions).toEqual([{ kind: "merge-main", branch: "agent/t1", into: "main" }]);
    expect(plan.squash).toMatchObject({ commits: 2, message: "chore: Fix login" });
    expect(plan.completed).toEqual([]);
  });

  it("squashes, rebases onto main and fast-forwards it without pushing", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    commit(repoPath, "other.txt", "main moved\n", "main moved");
    const { deliverer: d } = deliverer();

    const outcomes = await deliver(d, task, runRow, { actions: ["merge-main"], squash: true });

    expect(outcomes.map((o) => o.action)).toEqual(["squash", "merge-main"]);
    expect(subjects(repoPath, "main")).toEqual(["chore: Fix login", "main moved", "initial"]);
    expect(run(repoPath, "rev-parse", "main")).toBe(outcomes[1]!.detail);
    // Nothing left the machine.
    expect(subjects(originPath, "main")).toEqual(["initial"]);
  });

  it("resolves a rebase conflict and merges", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 1 });
    commit(repoPath, "f0.txt", "conflict\n", "main edits f0");
    const { deliverer: d } = deliverer();
    const resolveConflicts = vi.fn(async () => {
      writeFileSync(join(task.worktreePath!, "f0.txt"), "conflict\n0\n");
    });

    const outcomes = await deliver(
      d,
      task,
      runRow,
      { actions: ["merge-main"] },
      [],
      resolveConflicts,
    );

    expect(resolveConflicts).toHaveBeenCalledWith({
      branch: "agent/t1",
      into: "main",
      files: ["f0.txt"],
    });
    const sha = run(repoPath, "rev-parse", "main");
    expect(outcomes).toEqual([
      { action: "merge-main", detail: `${sha} (resolved conflicts in f0.txt)` },
    ]);
    expect(subjects(repoPath, "main")).toEqual(["edit f0.txt", "main edits f0", "initial"]);
  });

  it("stops on a rebase conflict the implementer cannot resolve and leaves main alone", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 1 });
    commit(repoPath, "f0.txt", "conflict\n", "main edits f0");
    const before = run(repoPath, "rev-parse", "main");
    const { deliverer: d } = deliverer();

    const delivered = deliver(d, task, runRow, { actions: ["merge-main"] }, [], () =>
      Promise.reject(new Error("The claude usage limit was reached")),
    );
    await expect(delivered).rejects.toThrow(DeliveryError);
    await expect(delivered).rejects.toThrow(
      /hit conflicts in f0\.txt\. The implementer could not resolve them: The claude usage limit was reached/,
    );
    expect(run(repoPath, "rev-parse", "main")).toBe(before);
  });

  it("refuses actions the task does not offer before doing anything", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    const { deliverer: d } = deliverer();
    const head = run(task.worktreePath!, "rev-parse", "HEAD");

    await expect(
      deliver(d, task, runRow, { actions: ["push-branch", "merge-main"], squash: true }),
    ).rejects.toThrow(InvalidGateResponseError);
    expect(run(task.worktreePath!, "rev-parse", "HEAD")).toBe(head);
  });

  it("squashes from origin/main when the branch was fast-forwarded past local main", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 0 });
    const other = join(root, "other");
    run(root, "clone", "--quiet", originPath, other);
    run(other, "config", "user.name", "Other");
    run(other, "config", "user.email", "other@example.com");
    run(other, "config", "commit.gpgsign", "false");
    commit(other, "origin.txt", "origin\n", "origin work");
    run(other, "push", "--quiet", "origin", "main");
    await git.fetchDefault(task.worktreePath!, "main");
    await git.fastForwardTo(task.worktreePath!, "agent/t1", "main");
    for (let i = 0; i < 2; i += 1) commit(task.worktreePath!, `f${i}.txt`, `${i}\n`);
    const { deliverer: d } = deliverer();

    // Only the task's two commits, not origin's, are squashed.
    expect((await d.plan(task, [])).squash).toMatchObject({ commits: 2 });
    await deliver(d, task, runRow, { actions: ["merge-main"], squash: true });
    expect(subjects(repoPath, "main")).toEqual(["chore: Fix login", "origin work", "initial"]);
  });

  it("squashes with the task title as a chore when there is no squash message", async () => {
    const { task } = await seed({ branch: "agent/t1", squashMessage: null });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).squash?.message).toBe("chore: Fix login");
  });

  it("offers no squash for a single commit", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 1 });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).squash).toBeNull();
    await expect(deliver(d, task, runRow, { squash: true })).rejects.toThrow(
      "There is nothing to squash",
    );
  });

  it("merges into the repo's default branch, leaving main alone", async () => {
    run(repoPath, "branch", "develop");
    const repo = r.repos.create({ path: repoPath, name: "app", remoteUrl: originPath });
    r.repos.update(repo.id, { defaultBranch: "develop" });
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    commit(repoPath, "other.txt", "main moved\n", "main moved");
    const { deliverer: d } = deliverer();

    expect((await d.plan(task, [])).actions).toEqual([
      { kind: "merge-main", branch: "agent/t1", into: "develop" },
    ]);
    const outcomes = await deliver(d, task, runRow, { actions: ["merge-main"] });

    expect(run(repoPath, "rev-parse", "develop")).toBe(outcomes[0]!.detail);
    expect(subjects(repoPath, "develop")).toEqual(["edit f1.txt", "edit f0.txt", "initial"]);
    expect(subjects(repoPath, "main")).toEqual(["main moved", "initial"]);
  });

  describe("with a GitHub remote", () => {
    const github = "https://github.com/acme/app.git";
    const pr = {
      kind: "open-pr",
      host: "github.com",
      owner: "acme",
      repo: "app",
      head: "feat/fix-login",
      base: "main",
      title: "Fix login",
      body: "Logins reject wrong passwords.",
    };

    it("offers the local merge, or a push as feat/<slug> and a PR", async () => {
      const { task } = await seed({ branch: "agent/t1" }, { remoteUrl: github });
      const { deliverer: d } = deliverer();
      expect((await d.plan(task, [])).actions).toEqual([
        { kind: "merge-main", branch: "agent/t1", into: "main" },
        { kind: "push-branch", branch: "feat/fix-login", remote: github, from: "agent/t1" },
        pr,
      ]);
    });

    it("names a bugfix's branch fix/<slug>", async () => {
      const { task } = await seed(
        { branch: "agent/t1", squashMessage: "fix: login" },
        { remoteUrl: github },
      );
      const { deliverer: d } = deliverer();
      expect((await d.plan(task, [])).actions[1]).toMatchObject({ branch: "fix/fix-login" });
    });

    it("suffixes the branch name past an existing branch", async () => {
      run(repoPath, "branch", "feat/fix-login");
      const { task } = await seed({ branch: "agent/t1" }, { remoteUrl: github });
      const { deliverer: d } = deliverer();
      const { actions } = await d.plan(task, []);
      expect(actions[1]).toMatchObject({ branch: "feat/fix-login-2", from: "agent/t1" });
      expect(actions[2]).toMatchObject({ head: "feat/fix-login-2" });
    });

    it("renames the branch, pushes it and opens the PR, leaving main alone", async () => {
      const { task, run: runRow } = await seed({ branch: "agent/t1" }, { remoteUrl: github });
      const main = run(repoPath, "rev-parse", "main");
      const { deliverer: d, ports } = deliverer();
      const renameBranch = vi.fn();
      const outcomes: DeliveryOutcome[] = [];

      await d.deliver({
        task,
        run: runRow,
        confirmation: deliveryConfirmationSchema.parse({ actions: ["push-branch", "open-pr"] }),
        completed: [],
        record: (o) => outcomes.push(o),
        resolveConflicts: () => Promise.reject(new Error("no resolver")),
        renameBranch,
      });

      expect(outcomes.map((o) => o.action)).toEqual(["push-branch", "open-pr"]);
      expect(run(task.worktreePath!, "symbolic-ref", "--short", "HEAD")).toBe("feat/fix-login");
      expect(run(originPath, "rev-parse", "refs/heads/feat/fix-login")).toBe(
        run(task.worktreePath!, "rev-parse", "HEAD"),
      );
      expect(renameBranch).toHaveBeenCalledWith("feat/fix-login");
      expect(ports.openPullRequest).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ head: "feat/fix-login", base: "main" }),
      );
      expect(run(repoPath, "rev-parse", "main")).toBe(main);
    });

    it("refuses merging and opening a PR together before doing anything", async () => {
      const { task, run: runRow } = await seed({ branch: "agent/t1" }, { remoteUrl: github });
      const { deliverer: d, ports } = deliverer();
      const head = run(task.worktreePath!, "rev-parse", "HEAD");

      await expect(
        deliver(d, task, runRow, { actions: ["merge-main", "push-branch"], squash: true }),
      ).rejects.toThrow("Merge locally or open a pull request, not both");
      expect(run(task.worktreePath!, "rev-parse", "HEAD")).toBe(head);
      expect(run(task.worktreePath!, "symbolic-ref", "--short", "HEAD")).toBe("agent/t1");
      expect(ports.openPullRequest).not.toHaveBeenCalled();
    });

    it("retries only the PR once the push went through, never the merge", async () => {
      const { task, run: runRow } = await seed({ branch: "agent/t1" }, { remoteUrl: github });
      const failing = deliverer(
        fakePorts({
          openPullRequest: vi.fn(async () => {
            throw new Error("github.com: rate limited");
          }),
        }),
      );
      const outcomes: DeliveryOutcome[] = [];
      await expect(
        failing.deliverer.deliver({
          task,
          run: runRow,
          confirmation: deliveryConfirmationSchema.parse({ actions: ["push-branch", "open-pr"] }),
          completed: [],
          record: (o) => outcomes.push(o),
          resolveConflicts: () => Promise.reject(new Error("no resolver")),
        }),
      ).rejects.toThrow(DeliveryError);
      expect(outcomes.map((o) => o.action)).toEqual(["push-branch"]);

      const renamed = r.tasks.update(task.id, { branch: "feat/fix-login" });
      const { deliverer: d, ports } = deliverer();
      const plan = await d.plan(renamed, ["push-branch"]);
      expect(plan.actions).toEqual([
        { kind: "push-branch", branch: "feat/fix-login", remote: github },
        pr,
      ]);
      expect(plan.completed).toEqual(["push-branch"]);

      await expect(
        deliver(d, renamed, runRow, { actions: ["merge-main"] }, ["push-branch"]),
      ).rejects.toThrow(InvalidGateResponseError);
      await deliver(d, renamed, runRow, { actions: ["open-pr"] }, ["push-branch"]);
      expect(ports.openPullRequest).toHaveBeenCalledWith(
        renamed,
        expect.objectContaining({ head: "feat/fix-login" }),
      );
    });

    it("offers only the push once an earlier delivery pushed and opened the PR", async () => {
      const seeded = await seed({ branch: "feat/fix-login" }, { remoteUrl: github });
      const task = r.tasks.update(seeded.task.id, { deliveryTargets: ["push-branch", "open-pr"] });
      const { deliverer: d } = deliverer();
      expect((await d.plan(task, [])).actions).toEqual([
        { kind: "push-branch", branch: "feat/fix-login", remote: github },
      ]);
    });

    it("still offers the merge for a branch renamed but never pushed", async () => {
      const { task } = await seed({ branch: "feat/fix-login" }, { remoteUrl: github });
      const { deliverer: d } = deliverer();
      expect((await d.plan(task, [])).actions).toEqual([
        { kind: "merge-main", branch: "feat/fix-login", into: "main" },
        { kind: "push-branch", branch: "feat/fix-login", remote: github },
        pr,
      ]);
    });
  });
});

describe("Jira tasks", () => {
  const jira = {
    branch: "feature/abc-1-fix-login",
    origin: { kind: "jira-issue" as const, key: "ABC-1", connectionId: null },
  };

  it("opens the PR against the repo's default branch", async () => {
    const repo = r.repos.create({ path: repoPath, name: "app", remoteUrl: originPath });
    r.repos.update(repo.id, { defaultBranch: "develop" });
    const { task } = await seed(jira, { remoteUrl: "https://github.com/acme/app.git" });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).actions).toContainEqual(
      expect.objectContaining({ kind: "open-pr", base: "develop" }),
    );
  });

  it("squashes with a Conventional Commits message, the key after the type", async () => {
    const { deliverer: d } = deliverer();
    let n = 0;
    const planned = async (squashMessage: string | null) => {
      n += 1;
      const { task } = await seed({ ...jira, branch: `${jira.branch}-${n}`, squashMessage });
      return (await d.plan(task, [])).squash?.message;
    };
    expect(await planned(null)).toBe("chore: ABC-1 Fix login");
    expect(await planned("ABC-1 Fix login")).toBe("chore: ABC-1 Fix login");
    expect(await planned("feat: ABC-1 add login")).toBe("feat: ABC-1 add login");
  });

  it("offers push, PR and Jira comment with their exact targets", async () => {
    const { task } = await seed(jira, { remoteUrl: "https://github.com/acme/app.git" });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).actions).toEqual([
      {
        kind: "push-branch",
        branch: "feature/abc-1-fix-login",
        remote: "https://github.com/acme/app.git",
      },
      {
        kind: "open-pr",
        host: "github.com",
        owner: "acme",
        repo: "app",
        head: "feature/abc-1-fix-login",
        base: "main",
        title: "ABC-1 Fix login",
        body: "Logins reject wrong passwords.",
      },
      {
        kind: "jira-comment",
        key: "ABC-1",
        url: "https://acme.atlassian.net/browse/ABC-1",
        body: "Logins reject wrong passwords.",
      },
    ]);
  });

  it("pushes the branch, then opens the PR and comments on the issue", async () => {
    const { task, run: runRow } = await seed(jira, {
      remoteUrl: "https://github.com/acme/app.git",
    });
    const { deliverer: d, ports } = deliverer();

    const outcomes = await deliver(d, task, runRow, {
      actions: ["jira-comment", "open-pr", "push-branch"],
    });

    expect(outcomes).toEqual([
      {
        action: "push-branch",
        detail: "https://github.com/acme/app.git feature/abc-1-fix-login",
      },
      { action: "open-pr", detail: "https://github.com/acme/app/pull/8" },
      { action: "jira-comment", detail: "https://acme.atlassian.net/browse/ABC-1" },
    ]);
    expect(run(originPath, "rev-parse", "feature/abc-1-fix-login")).toBe(
      run(task.worktreePath!, "rev-parse", "HEAD"),
    );
    expect(ports.openPullRequest).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ head: "feature/abc-1-fix-login", base: "main" }),
    );
    expect(ports.commentOnJiraIssue).toHaveBeenCalledWith(task, "Logins reject wrong passwords.");
  });

  it("performs only the confirmed actions", async () => {
    const { task, run: runRow } = await seed(jira);
    const { deliverer: d, ports } = deliverer();
    await deliver(d, task, runRow, { actions: ["jira-comment"] });
    expect(ports.commentOnJiraIssue).toHaveBeenCalledOnce();
    expect(ports.openPullRequest).not.toHaveBeenCalled();
    expect(() => run(originPath, "rev-parse", "--verify", "feature/abc-1-fix-login")).toThrow();
  });

  it("needs the branch pushed to open a PR", async () => {
    const { task, run: runRow } = await seed(jira, {
      remoteUrl: "https://github.com/acme/app.git",
    });
    const { deliverer: d, ports } = deliverer();
    await expect(deliver(d, task, runRow, { actions: ["open-pr"] })).rejects.toThrow(
      "Opening a pull request needs the branch pushed",
    );
    // A retry after the push went through may open it alone.
    await deliver(d, task, runRow, { actions: ["open-pr"] }, ["push-branch"]);
    expect(ports.openPullRequest).toHaveBeenCalledOnce();
  });

  it("skips completed actions and offers no squash once the branch is pushed", async () => {
    const { task, run: runRow } = await seed(jira, {
      remoteUrl: "https://github.com/acme/app.git",
    });
    const { deliverer: d, ports } = deliverer();
    const plan = await d.plan(task, ["push-branch"]);
    expect(plan).toMatchObject({ squash: null, completed: ["push-branch"] });

    const outcomes = await deliver(d, task, runRow, { actions: ["push-branch", "open-pr"] }, [
      "push-branch",
    ]);
    expect(outcomes.map((o) => o.action)).toEqual(["open-pr"]);
    expect(ports.openPullRequest).toHaveBeenCalledOnce();
  });

  it("wraps a failing call in a DeliveryError and lets a missing token through", async () => {
    const { task, run: runRow } = await seed(jira);
    const failing = deliverer(
      fakePorts({
        commentOnJiraIssue: vi.fn(async () => {
          throw new Error("acme.atlassian.net: access denied");
        }),
      }),
    );
    await expect(
      deliver(failing.deliverer, task, runRow, { actions: ["jira-comment"] }),
    ).rejects.toThrow(DeliveryError);

    const missing = deliverer(
      fakePorts({
        commentOnJiraIssue: vi.fn(async () => {
          throw new MissingCredentialError("jira", "acme.atlassian.net", null);
        }),
      }),
    );
    await expect(
      deliver(missing.deliverer, task, runRow, { actions: ["jira-comment"] }),
    ).rejects.toThrow(MissingCredentialError);
  });

  describe("live origin", () => {
    const github = "https://github.com/acme/app.git";

    it("offers push and PR for an origin added after the repo was registered", async () => {
      const { task, run: runRow } = await seed(jira, { remoteUrl: null });
      run(repoPath, "remote", "remove", "origin");
      run(repoPath, "remote", "add", "origin", github);
      fakeOrigin(github);
      const { deliverer: d } = deliverer();

      const plan = await d.plan(task, []);
      expect(plan.actions[0]).toEqual({
        kind: "push-branch",
        branch: "feature/abc-1-fix-login",
        remote: github,
      });
      expect(plan.actions.map((a) => a.kind)).toEqual(["push-branch", "open-pr", "jira-comment"]);

      await deliver(d, task, runRow, { actions: ["push-branch"] });
      expect(run(originPath, "rev-parse", "feature/abc-1-fix-login")).toBe(
        run(task.worktreePath!, "rev-parse", "HEAD"),
      );
    });

    it("offers no push or PR once origin is removed, whatever the repo row caches", async () => {
      const { task, run: runRow } = await seed(jira);
      run(repoPath, "remote", "remove", "origin");
      const { deliverer: d } = deliverer();

      expect((await d.plan(task, [])).actions.map((a) => a.kind)).toEqual(["jira-comment"]);
      await expect(deliver(d, task, runRow, { actions: ["push-branch"] })).rejects.toThrow(
        InvalidGateResponseError,
      );
    });

    it("follows an origin URL changed after the repo was registered", async () => {
      const { task } = await seed(jira);
      fakeOrigin(github);
      const { deliverer: d } = deliverer();

      const { actions } = await d.plan(task, []);
      expect(actions[0]).toMatchObject({ kind: "push-branch", remote: github });
      expect(actions.map((a) => a.kind)).toEqual(["push-branch", "open-pr", "jira-comment"]);
    });
  });
});

describe("GitHub issue tasks", () => {
  const issue = {
    branch: "feature/7-fix-login",
    origin: {
      kind: "github-issue" as const,
      url: "https://github.com/acme/app/issues/7",
      owner: "acme",
      repo: "app",
      number: 7,
      connectionId: null,
    },
  };

  it("offers push, a PR that closes the issue and an issue comment", async () => {
    const { task } = await seed(issue, { remoteUrl: "https://github.com/acme/app.git" });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).actions).toEqual([
      {
        kind: "push-branch",
        branch: "feature/7-fix-login",
        remote: "https://github.com/acme/app.git",
      },
      {
        kind: "open-pr",
        host: "github.com",
        owner: "acme",
        repo: "app",
        head: "feature/7-fix-login",
        base: "main",
        title: "Fix login",
        body: "Logins reject wrong passwords.\n\nCloses acme/app#7",
      },
      {
        kind: "issue-comment",
        url: "https://github.com/acme/app/issues/7",
        body: "Logins reject wrong passwords.",
      },
    ]);
  });

  it("falls back to the summary without the findings left open when there is no short summary", async () => {
    const { task } = await seed(
      {
        ...issue,
        summary: "Compared passwords strictly.\n\n### Left open\n\n- **[low] Naming**: Rename it.",
        shortSummary: null,
      },
      { remoteUrl: "https://github.com/acme/app.git" },
    );
    const { deliverer: d } = deliverer();
    const actions = (await d.plan(task, [])).actions;
    expect(JSON.stringify(actions)).not.toContain("### Left open");
    expect(actions).toContainEqual(
      expect.objectContaining({
        kind: "open-pr",
        body: "Compared passwords strictly.\n\nCloses acme/app#7",
      }),
    );
    expect(actions).toContainEqual(
      expect.objectContaining({ kind: "issue-comment", body: "Compared passwords strictly." }),
    );
  });

  it("pushes the branch, then opens the PR and comments on the issue", async () => {
    const { task, run: runRow } = await seed(issue, {
      remoteUrl: "https://github.com/acme/app.git",
    });
    const ports = fakePorts({
      commentOnGitHubIssue: vi.fn(async () => ({
        url: "https://github.com/acme/app/issues/7#issuecomment-2",
      })),
    });
    const { deliverer: d } = deliverer(ports);

    const outcomes = await deliver(d, task, runRow, {
      actions: ["issue-comment", "open-pr", "push-branch"],
    });

    expect(outcomes).toEqual([
      { action: "push-branch", detail: "https://github.com/acme/app.git feature/7-fix-login" },
      { action: "open-pr", detail: "https://github.com/acme/app/pull/8" },
      {
        action: "issue-comment",
        detail: "https://github.com/acme/app/issues/7#issuecomment-2",
      },
    ]);
    expect(ports.openPullRequest).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ body: "Logins reject wrong passwords.\n\nCloses acme/app#7" }),
    );
    expect(ports.commentOnGitHubIssue).toHaveBeenCalledWith(task, "Logins reject wrong passwords.");
  });

  describe("delivered before (Fix CI)", () => {
    /** The issue task pushed (and its targets recorded), as a first delivery leaves it. */
    async function pushed(deliveryTargets: ("push-branch" | "open-pr" | "issue-comment")[]) {
      const { task, run: runRow } = await seed(issue, {
        remoteUrl: "https://github.com/acme/app.git",
      });
      const { deliverer: d } = deliverer();
      await deliver(d, task, runRow, { actions: ["push-branch"] });
      return { d, task: r.tasks.update(task.id, { deliveryTargets }) };
    }

    const kinds = (actions: { kind: string }[]) => actions.map((a) => a.kind);

    it("does not offer open-pr again once a PR was opened", async () => {
      const { d, task } = await pushed(["push-branch", "open-pr", "issue-comment"]);
      commit(task.worktreePath!, "fix.txt", "fixed\n");
      const plan = await d.plan(task, []);
      expect(kinds(plan.actions)).toEqual(["push-branch", "issue-comment"]);
    });

    it("squashes only the commits after the pushed branch", async () => {
      const { d, task } = await pushed(["push-branch", "open-pr"]);
      commit(task.worktreePath!, "fix.txt", "fixed\n");
      expect((await d.plan(task, [])).squash).toBeNull();

      commit(task.worktreePath!, "fix2.txt", "fixed again\n");
      const pushedHead = run(task.worktreePath!, "rev-parse", `origin/${issue.branch}`);
      expect((await d.plan(task, [])).squash).toEqual({
        commits: 2,
        base: pushedHead,
        message: "chore: Fix login",
      });
    });

    it("still offers the push and comment without a new commit, but no PR or squash", async () => {
      const { d, task } = await pushed(["push-branch", "open-pr", "issue-comment"]);
      const plan = await d.plan(task, []);
      expect(kinds(plan.actions)).toEqual(["push-branch", "issue-comment"]);
      expect(plan.squash).toBeNull();
    });

    it("integrates the remote branch on a later push, but not on the first", async () => {
      const { task, run: runRow } = await seed(issue, {
        remoteUrl: "https://github.com/acme/app.git",
      });
      const push = vi.fn(git.push);
      const d = createDeliverer({ git: { ...git, push }, repositories: r, ports: fakePorts() });
      await deliver(d, task, runRow, { actions: ["push-branch"] });
      expect(push.mock.calls[0]![3]).toEqual({});

      const again = r.tasks.update(task.id, { deliveryTargets: ["push-branch"] });
      commit(again.worktreePath!, "fix.txt", "fixed\n");
      await deliver(d, again, runRow, { actions: ["push-branch"] });
      expect(push.mock.calls[1]![3]).toEqual({ integrate: { resolve: expect.any(Function) } });
    });

    it("still offers open-pr after a push that opened none", async () => {
      const { d, task } = await pushed(["push-branch"]);
      const plan = await d.plan(task, []);
      expect(kinds(plan.actions)).toEqual(["push-branch", "open-pr", "issue-comment"]);
      expect(plan.squash).toBeNull();
    });
  });

  it("does not integrate a branch someone else already pushed on a first push", async () => {
    const { task, run: runRow } = await seed(issue);
    const stranger = join(root, "stranger");
    run(root, "clone", "--quiet", originPath, stranger);
    run(stranger, "config", "user.name", "Stranger");
    run(stranger, "config", "user.email", "stranger@example.com");
    run(stranger, "switch", "--quiet", "-c", issue.branch);
    commit(stranger, "theirs.txt", "theirs\n", "unrelated work");
    run(stranger, "push", "--quiet", "origin", issue.branch);
    const { deliverer: d } = deliverer();

    const failed = deliver(d, task, runRow, { actions: ["push-branch"] });
    await expect(failed).rejects.toThrow(DeliveryError);
    await expect(failed).rejects.toThrow(
      "The remote branch has commits this branch does not. Pull or rebase it, then finish again.",
    );
    expect(subjects(originPath, issue.branch)).toEqual(["unrelated work", "initial"]);
  });

  it("explains a git authentication failure", async () => {
    const { task, run: runRow } = await seed(issue);
    const push = vi.fn(async () => {
      throw new GitError(
        ["push"],
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
        128,
      );
    });
    const d = createDeliverer({ git: { ...git, push }, repositories: r, ports: fakePorts() });

    const failed = deliver(d, task, runRow, { actions: ["push-branch"] });
    await expect(failed).rejects.toThrow(DeliveryError);
    await expect(failed).rejects.toThrow(
      "Git could not authenticate to the remote. Set up git credentials (credential manager or SSH key) for it; this is not the blackwall token. (fatal: could not read Username for 'https://github.com': terminal prompts disabled)",
    );
  });

  it("comments on the issue alone when only that is confirmed", async () => {
    const { task, run: runRow } = await seed(issue);
    const { deliverer: d, ports } = deliverer();
    await deliver(d, task, runRow, { actions: ["issue-comment"] });
    expect(ports.commentOnGitHubIssue).toHaveBeenCalledOnce();
    expect(ports.openPullRequest).not.toHaveBeenCalled();
    expect(() => run(originPath, "rev-parse", "--verify", "feature/7-fix-login")).toThrow();
  });

  it("lets a missing token through and wraps other failures", async () => {
    const { task, run: runRow } = await seed(issue);
    const { deliverer: d } = deliverer(
      fakePorts({
        commentOnGitHubIssue: vi.fn(async () => {
          throw new MissingCredentialError("github", "github.com", null);
        }),
      }),
    );
    await expect(deliver(d, task, runRow, { actions: ["issue-comment"] })).rejects.toThrow(
      MissingCredentialError,
    );
    await expect(d.commentOnIssue(task, "Plan approved.")).rejects.toThrow(MissingCredentialError);

    const failing = deliverer(
      fakePorts({
        commentOnGitHubIssue: vi.fn(async () => {
          throw new Error("github.com: access denied");
        }),
      }),
    );
    const posted = failing.deliverer.commentOnIssue(task, "Plan approved.");
    await expect(posted).rejects.toThrow(DeliveryError);
    await expect(posted).rejects.toThrow("github.com: access denied");
  });

  it("comments on the issue during the run, and refuses other tasks", async () => {
    const { task } = await seed(issue);
    const { deliverer: d, ports } = deliverer();
    await expect(d.commentOnIssue(task, "Plan approved.")).resolves.toEqual({
      url: "https://github.com/acme/app/issues/7#issuecomment-1",
    });
    expect(ports.commentOnGitHubIssue).toHaveBeenCalledWith(task, "Plan approved.");

    const { task: jiraTask } = await seed({
      branch: "feature/abc-1-x",
      origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
    });
    await expect(d.commentOnIssue(jiraTask, "Plan approved.")).rejects.toThrow(
      InvalidGateResponseError,
    );
    expect(ports.commentOnGitHubIssue).toHaveBeenCalledOnce();
  });
});

describe("pull request tasks", () => {
  const pr = {
    kind: "github-pr" as const,
    url: "https://github.com/acme/app/pull/7",
    owner: "acme",
    repo: "app",
    number: 7,
    connectionId: null,
  };

  beforeEach(() => {
    run(repoPath, "checkout", "--quiet", "-b", "feature/pr");
    commit(repoPath, "pr.txt", "author's work\n", "author's work");
    run(repoPath, "push", "--quiet", "origin", "feature/pr");
    run(repoPath, "checkout", "--quiet", "main");
  });

  it("pushes to the PR branch and comments, squashing only the harness's commits", async () => {
    const { task, run: runRow } = await seed(
      { branch: "feature/pr", origin: pr, mode: "work" },
      { existing: true },
    );
    const { deliverer: d, ports } = deliverer();
    const plan = await d.plan(task, []);
    expect(plan.actions).toEqual([
      { kind: "push-branch", branch: "feature/pr", remote: originPath },
      { kind: "pr-comment", url: pr.url, body: "Logins reject wrong passwords." },
    ]);
    expect(plan.squash).toMatchObject({ commits: 2 });

    await deliver(d, task, runRow, { actions: ["push-branch", "pr-comment"], squash: true });
    expect(subjects(originPath, "feature/pr")).toEqual([
      "chore: Fix login",
      "author's work",
      "initial",
    ]);
    expect(ports.commentOnPullRequest).toHaveBeenCalledWith(task, "Logins reject wrong passwords.");
  });

  describe("when the author pushed to the PR meanwhile", () => {
    /** The author adds `file` to the PR branch on the remote from their own clone. */
    function authorPushes(file: string, content: string): void {
      const author = join(root, "author");
      run(root, "clone", "--quiet", "--branch", "feature/pr", originPath, author);
      run(author, "config", "user.name", "Author");
      run(author, "config", "user.email", "author@example.com");
      commit(author, file, content, "author's follow-up");
      run(author, "push", "--quiet", "origin", "feature/pr");
    }

    it("rebases onto the PR branch, resolving conflicts with the implementer, and pushes", async () => {
      const { task, run: runRow } = await seed(
        { branch: "feature/pr", origin: pr, mode: "work" },
        { existing: true, commits: 1 },
      );
      authorPushes("f0.txt", "author\n");
      const push = vi.fn(git.push);
      const d = createDeliverer({ git: { ...git, push }, repositories: r, ports: fakePorts() });
      const conflicts: string[][] = [];

      const outcomes = await deliver(
        d,
        task,
        runRow,
        { actions: ["push-branch"] },
        [],
        async (c) => {
          conflicts.push(c.files);
          expect(c).toMatchObject({ branch: "feature/pr", into: "origin/feature/pr" });
          writeFileSync(join(task.worktreePath!, "f0.txt"), "both\n");
        },
      );

      expect(push.mock.calls[0]![3]).toEqual({ integrate: { resolve: expect.any(Function) } });
      expect(conflicts).toEqual([["f0.txt"]]);
      expect(outcomes).toEqual([
        {
          action: "push-branch",
          detail: `${originPath} feature/pr (rebased onto origin/feature/pr, resolved conflicts in f0.txt)`,
        },
      ]);
      expect(subjects(originPath, "feature/pr")).toEqual([
        "edit f0.txt",
        "author's follow-up",
        "author's work",
        "initial",
      ]);
    });

    it("pushes nothing and names the files when the conflicts stay unresolved", async () => {
      const { task, run: runRow } = await seed(
        { branch: "feature/pr", origin: pr, mode: "work" },
        { existing: true, commits: 1 },
      );
      authorPushes("f0.txt", "author\n");
      const { deliverer: d } = deliverer();

      const failed = deliver(d, task, runRow, { actions: ["push-branch"] });
      await expect(failed).rejects.toThrow(DeliveryError);
      await expect(failed).rejects.toThrow(
        "origin/feature/pr has commits feature/pr does not, and rebasing onto them hit conflicts in f0.txt. The implementer could not resolve them: no resolver.",
      );
      expect(subjects(originPath, "feature/pr")).toEqual([
        "author's follow-up",
        "author's work",
        "initial",
      ]);
    });
  });

  it("offers no push when the PR's head branch is main", async () => {
    // Frees main so the task's worktree can check it out.
    run(repoPath, "checkout", "--quiet", "--detach");
    const { task, run: runRow } = await seed(
      { branch: "main", origin: pr, mode: "work" },
      { existing: true },
    );
    const { deliverer: d, ports } = deliverer();
    const plan = await d.plan(task, []);
    expect(plan.actions).toEqual([
      { kind: "pr-comment", url: pr.url, body: "Logins reject wrong passwords." },
    ]);

    await expect(
      deliver(d, task, runRow, { actions: ["push-branch", "pr-comment"] }),
    ).rejects.toThrow(InvalidGateResponseError);
    expect(subjects(originPath, "main")).toEqual(["initial"]);
    expect(ports.commentOnPullRequest).not.toHaveBeenCalled();
  });

  it("offers no push when the PR's head branch is the repo's default branch", async () => {
    run(repoPath, "checkout", "--quiet", "-b", "trunk");
    run(repoPath, "push", "--quiet", "origin", "trunk");
    run(repoPath, "checkout", "--quiet", "main");
    const { task } = await seed({ branch: "trunk", origin: pr, mode: "work" }, { existing: true });
    r.repos.update(task.repoId, { defaultBranch: "trunk" });
    const { deliverer: d } = deliverer();
    const plan = await d.plan(task, []);
    expect(plan.actions).toEqual([
      { kind: "pr-comment", url: pr.url, body: "Logins reject wrong passwords." },
    ]);
  });

  it("posts only the selected findings of a Review PR task", async () => {
    const { task, run: runRow } = await seed(
      { branch: "feature/pr", origin: pr, mode: "review" },
      { existing: true, commits: 0 },
    );
    const finding = (title: string) => ({
      taskId: task.id,
      runId: runRow.id,
      severity: "high" as const,
      title,
      explanation: "e",
    });
    const [kept, dropped, ignored] = r.findings.createMany([
      finding("Kept"),
      finding("Dropped"),
      finding("Ignored"),
    ]);
    r.findings.setStatus(ignored!.id, "force-ignore");
    const { deliverer: d, ports } = deliverer();

    // Review PR tasks never propose follow-ups; stray ones are not offered.
    r.tasks.update(task.id, { followUps: [{ title: "A", description: "Do A", repoId: null }] });
    const plan = await d.plan(r.tasks.get(task.id)!, []);
    expect(plan).toEqual({
      actions: [{ kind: "pr-review", url: pr.url, findingIds: [kept!.id, dropped!.id] }],
      squash: null,
      completed: [],
    });

    await expect(
      deliver(d, task, runRow, { actions: ["pr-review"], findingIds: [ignored!.id] }),
    ).rejects.toThrow(InvalidGateResponseError);
    await deliver(d, task, runRow, { actions: ["pr-review"], findingIds: [kept!.id] });
    expect(ports.reviewPullRequest).toHaveBeenCalledWith(
      task,
      [expect.objectContaining({ id: kept!.id })],
      { approve: false },
    );
  });

  it("offers only the latest run's findings of a re-reviewed Review PR task", async () => {
    const { task, run: first } = await seed(
      { branch: "feature/pr", origin: pr, mode: "review" },
      { existing: true, commits: 0 },
    );
    const second = r.runs.create(task.id);
    const finding = (runId: string, title: string) => ({
      taskId: task.id,
      runId,
      severity: "high" as const,
      title,
      explanation: "e",
    });
    const [, unposted, latest] = r.findings.createMany([
      finding(first.id, "Posted"),
      finding(first.id, "Not posted"),
      finding(second.id, "New"),
    ]);
    r.findings.setStatus(unposted!.id, "force-fix");
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).actions).toEqual([
      { kind: "pr-review", url: pr.url, findingIds: [latest!.id] },
    ]);
  });

  it("approves a Review PR task with no findings when the user opts in", async () => {
    const { task, run: runRow } = await seed(
      { branch: "feature/pr", origin: pr, mode: "review" },
      { existing: true, commits: 0 },
    );
    const { deliverer: d, ports } = deliverer();
    expect((await d.plan(task, [])).actions).toEqual([
      { kind: "pr-review", url: pr.url, findingIds: [] },
    ]);

    await deliver(d, task, runRow, { actions: ["pr-review"], approve: true });
    expect(ports.reviewPullRequest).toHaveBeenCalledWith(task, [], { approve: true });
  });

  it("approves a Review PR task with the picked findings as comments", async () => {
    const { task, run: runRow } = await seed(
      { branch: "feature/pr", origin: pr, mode: "review" },
      { existing: true, commits: 0 },
    );
    const [picked] = r.findings.createMany([
      {
        taskId: task.id,
        runId: runRow.id,
        severity: "low",
        title: "Picked",
        explanation: "e",
      },
      {
        taskId: task.id,
        runId: runRow.id,
        severity: "low",
        title: "Left out",
        explanation: "e",
      },
    ]);
    const { deliverer: d, ports } = deliverer();

    await deliver(d, task, runRow, {
      actions: ["pr-review"],
      findingIds: [picked!.id],
      approve: true,
    });
    expect(ports.reviewPullRequest).toHaveBeenCalledWith(
      task,
      [expect.objectContaining({ id: picked!.id })],
      { approve: true },
    );
  });

  it("refuses to approve without the pr-review action", async () => {
    const { task, run: runRow } = await seed(
      { branch: "feature/pr", origin: pr, mode: "review" },
      { existing: true, commits: 0 },
    );
    const { deliverer: d, ports } = deliverer();

    await expect(deliver(d, task, runRow, { approve: true })).rejects.toThrow(
      InvalidGateResponseError,
    );
    expect(ports.reviewPullRequest).not.toHaveBeenCalled();
  });
});

describe("follow-up tasks", () => {
  let apiId: string;
  const followUp = (title: string, repoId: string | null = null) => ({
    title,
    description: `Do ${title}`,
    repoId,
  });

  beforeEach(() => {
    apiId = r.repos.create({ path: join(root, "api"), name: "api" }).id;
  });

  it("offers create-tasks only with follow-ups, after the merge", async () => {
    const { task } = await seed({ branch: "agent/t1", followUps: [followUp("A"), followUp("B")] });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).actions).toEqual([
      { kind: "merge-main", branch: "agent/t1", into: "main" },
      {
        kind: "create-tasks",
        items: [
          { title: "A", description: "Do A", repoId: task.repoId, repoName: "app" },
          { title: "B", description: "Do B", repoId: task.repoId, repoName: "app" },
        ],
      },
    ]);
    const plain = await seed({ branch: "agent/t2" });
    expect((await d.plan(plain.task, [])).actions.map((a) => a.kind)).toEqual(["merge-main"]);
  });

  it("merges first, then creates only the picked follow-ups as waiting items", async () => {
    const { task, run: runRow } = await seed({
      branch: "agent/t1",
      followUps: [followUp("A"), followUp("B", apiId), followUp("C"), followUp("D")],
    });
    const changed = vi.fn();
    const { deliverer: d } = deliverer(fakePorts(), changed);

    const outcomes = await deliver(d, task, runRow, {
      actions: ["create-tasks", "merge-main"],
      followUpIndexes: [0, 1, 3],
    });

    expect(outcomes.map((o) => o.action)).toEqual(["merge-main", "create-tasks"]);
    expect(outcomes[1]!.detail).toBe("3 tasks: app: A; api: B; app: D");
    expect(r.backlogItems.list(task.repoId)).toMatchObject([
      { title: "A", status: "waiting", dependsOn: [], sourceTaskId: task.id },
      { title: "D", status: "waiting", dependsOn: [], sourceTaskId: task.id },
    ]);
    expect(r.backlogItems.list(apiId)).toMatchObject([{ title: "B", freeText: "Do B" }]);
    expect(changed.mock.calls).toEqual([[task.repoId], [apiId]]);
  });

  it("refuses follow-up picks that do not fit the plan", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1", followUps: [followUp("A")] });
    const { deliverer: d } = deliverer();
    for (const confirmation of [
      { actions: ["merge-main" as const], followUpIndexes: [0] },
      { actions: ["create-tasks" as const], followUpIndexes: [1] },
      { actions: ["create-tasks" as const] },
    ]) {
      await expect(deliver(d, task, runRow, confirmation)).rejects.toThrow(
        InvalidGateResponseError,
      );
    }
    expect(r.backlogItems.list()).toEqual([]);
  });

  it("offers no push, PR or merge for a branch without commits", async () => {
    const { deliverer: d } = deliverer();
    const local = await seed({ branch: "agent/t1", followUps: [followUp("A")] }, { commits: 0 });
    const plan = await d.plan(local.task, []);
    expect(plan.actions.map((a) => a.kind)).toEqual(["create-tasks"]);
    expect(plan.squash).toBeNull();

    const jira = await seed(
      {
        branch: "feature/abc-1-fix-login",
        origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
        followUps: [followUp("A")],
      },
      { commits: 0 },
    );
    expect((await d.plan(jira.task, [])).actions.map((a) => a.kind)).toEqual([
      "jira-comment",
      "create-tasks",
    ]);
  });

  it("keeps a completed merge in the plan on retry", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1", followUps: [followUp("A")] });
    const { deliverer: d } = deliverer();
    await deliver(d, task, runRow, { actions: ["merge-main"] });
    // The branch is now in main, so it has no commits of its own.
    const plan = await d.plan(task, ["merge-main"]);
    expect(plan.actions.map((a) => a.kind)).toEqual(["merge-main", "create-tasks"]);
    expect(plan.completed).toEqual(["merge-main"]);
    const outcomes = await deliver(
      d,
      task,
      runRow,
      { actions: ["merge-main", "create-tasks"], followUpIndexes: [0] },
      ["merge-main"],
    );
    expect(outcomes.map((o) => o.action)).toEqual(["create-tasks"]);
  });

  it("creates follow-ups for a task without a worktree", async () => {
    const repo = r.repos.create({ path: repoPath, name: "app", remoteUrl: originPath });
    const task = r.tasks.create({
      title: "Plan the work",
      origin: { kind: "free-text" },
      repoId: repo.id,
      branch: "agent/t1",
      followUps: [followUp("A"), followUp("B")],
    });
    const { deliverer: d } = deliverer();
    const outcomes = await deliver(d, task, r.runs.create(task.id), {
      actions: ["create-tasks"],
      followUpIndexes: [1],
    });
    expect(outcomes).toEqual([{ action: "create-tasks", detail: "1 task: app: B" }]);
    expect(r.backlogItems.list(repo.id)).toMatchObject([{ title: "B", status: "waiting" }]);
  });
});

describe("squash rejected by a commit hook", () => {
  const rejection = (hook: "commit-msg" | "pre-commit", output = "subject must be conventional") =>
    new GitError(["commit"], output, 1, { hook });

  /** A deliverer whose squash runs `squash` instead of git's. */
  function withSquash(squash: (message: string) => Promise<string | null>) {
    const spy = vi.fn((_worktree: string, _since: string, message: string) => squash(message));
    const d = createDeliverer({
      git: { ...git, squash: spy },
      repositories: r,
      ports: fakePorts(),
    });
    return { d, spy };
  }

  async function squashOnly(
    d: ReturnType<typeof createDeliverer>,
    task: Task,
    runRow: Run,
    extra: Pick<DeliveryContext, "rewriteCommitMessage" | "saveSquashMessage">,
  ) {
    await d.deliver({
      task,
      run: runRow,
      confirmation: deliveryConfirmationSchema.parse({ squash: true }),
      completed: [],
      record: () => undefined,
      resolveConflicts: () => Promise.reject(new Error("no resolver")),
      ...extra,
    });
  }

  it("has the message rewritten, retries and saves what landed", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    let calls = 0;
    const { d, spy } = withSquash(async () => {
      calls += 1;
      if (calls === 1) throw rejection("commit-msg");
      return "abc";
    });
    const rewriteCommitMessage = vi.fn(async () => "fix: login");
    const saveSquashMessage = vi.fn();
    await squashOnly(d, task, runRow, { rewriteCommitMessage, saveSquashMessage });
    expect(rewriteCommitMessage).toHaveBeenCalledWith(
      "chore: Fix login",
      "subject must be conventional",
    );
    expect(spy.mock.calls.map((c) => c[2])).toEqual(["chore: Fix login", "fix: login"]);
    expect(saveSquashMessage).toHaveBeenCalledWith("fix: login");
  });

  it("saves nothing when the planned message lands", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    const { d } = withSquash(async () => "abc");
    const saveSquashMessage = vi.fn();
    await squashOnly(d, task, runRow, { rewriteCommitMessage: vi.fn(), saveSquashMessage });
    expect(saveSquashMessage).not.toHaveBeenCalled();
  });

  it("gives up after 3 rewrites with the hook's output", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    const { d, spy } = withSquash(async () => {
      throw rejection("commit-msg", "still not conventional");
    });
    const rewriteCommitMessage = vi.fn(async () => "Still wrong");
    const saveSquashMessage = vi.fn();
    const error = await squashOnly(d, task, runRow, {
      rewriteCommitMessage,
      saveSquashMessage,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as Error).message).toContain("still not conventional");
    expect(rewriteCommitMessage).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(saveSquashMessage).not.toHaveBeenCalled();
  });

  it("fails at once without a rewriter", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    const { d, spy } = withSquash(async () => {
      throw rejection("commit-msg");
    });
    await expect(squashOnly(d, task, runRow, {})).rejects.toThrow(DeliveryError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite after a pre-commit rejection", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    const { d, spy } = withSquash(async () => {
      throw rejection("pre-commit", "lint failed");
    });
    const rewriteCommitMessage = vi.fn(async () => "feat: x");
    await expect(squashOnly(d, task, runRow, { rewriteCommitMessage })).rejects.toThrow(
      "lint failed",
    );
    expect(rewriteCommitMessage).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a conventional message, leaving the PR title alone", async () => {
    const { task } = await seed({ branch: "agent/t1", squashMessage: null });
    expect((await deliverer().deliverer.plan(task, [])).squash).toMatchObject({
      message: "chore: Fix login",
    });
    const jira = await seed(
      {
        branch: "feature/abc-1-fix-login",
        origin: { kind: "jira-issue", key: "ABC-1", connectionId: null },
        squashMessage: null,
      },
      { remoteUrl: "https://github.com/acme/app.git" },
    );
    const plan = await deliverer().deliverer.plan(jira.task, []);
    expect(plan.squash).toMatchObject({ message: "chore: ABC-1 Fix login" });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "open-pr", title: "ABC-1 Fix login" }),
    );
  });
});
