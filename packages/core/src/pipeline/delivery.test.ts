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
import { createGitService } from "../git/service.js";
import {
  DeliveryError,
  createDeliverer,
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
    reviewPullRequest: vi.fn(async () => ({ url: "https://github.com/acme/app/pull/7#r1" })),
    ...overrides,
  } satisfies DeliveryPorts;
}

/** A task with its worktree on `branch`, and `commits` commits made on it. */
async function seed(
  patch: Partial<Parameters<Repositories["tasks"]["create"]>[0]> & { branch: string },
  { commits = 2, remoteUrl = originPath, existing = false } = {},
): Promise<{ task: Task; run: Run }> {
  const repo =
    r.repos.getByPath(repoPath) ?? r.repos.create({ path: repoPath, name: "app", remoteUrl });
  const created = r.tasks.create({
    title: "Fix login",
    origin: { kind: "free-text" },
    repoId: repo.id,
    summary: "Compared passwords strictly.",
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

function deliverer(ports = fakePorts()) {
  return { ports, deliverer: createDeliverer({ git, repositories: r, ports }) };
}

async function deliver(
  d: ReturnType<typeof createDeliverer>,
  task: Task,
  runRow: Run,
  confirmation: DeliveryConfirmationInput,
  completed: DeliveryStep[] = [],
): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  await d.deliver({
    task,
    run: runRow,
    confirmation: deliveryConfirmationSchema.parse(confirmation),
    completed,
    record: (o) => outcomes.push(o),
  });
  return outcomes;
}

describe("free-text tasks", () => {
  it("offers the local merge and a squash, and never a push", async () => {
    const { task } = await seed({ branch: "agent/t1" });
    const { deliverer: d } = deliverer();
    const plan = await d.plan(task, []);
    expect(plan.actions).toEqual([{ kind: "merge-main", branch: "agent/t1", into: "main" }]);
    expect(plan.squash).toMatchObject({ commits: 2, message: "Fix login" });
    expect(plan.completed).toEqual([]);
  });

  it("squashes, rebases onto main and fast-forwards it without pushing", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" });
    commit(repoPath, "other.txt", "main moved\n", "main moved");
    const { deliverer: d } = deliverer();

    const outcomes = await deliver(d, task, runRow, { actions: ["merge-main"], squash: true });

    expect(outcomes.map((o) => o.action)).toEqual(["squash", "merge-main"]);
    expect(subjects(repoPath, "main")).toEqual(["Fix login", "main moved", "initial"]);
    expect(run(repoPath, "rev-parse", "main")).toBe(outcomes[1]!.detail);
    // Nothing left the machine.
    expect(subjects(originPath, "main")).toEqual(["initial"]);
  });

  it("stops on a rebase conflict and leaves main alone", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 1 });
    commit(repoPath, "f0.txt", "conflict\n", "main edits f0");
    const before = run(repoPath, "rev-parse", "main");
    const { deliverer: d } = deliverer();

    await expect(deliver(d, task, runRow, { actions: ["merge-main"] })).rejects.toThrow(
      /hit conflicts in f0\.txt/,
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

  it("offers no squash for a single commit", async () => {
    const { task, run: runRow } = await seed({ branch: "agent/t1" }, { commits: 1 });
    const { deliverer: d } = deliverer();
    expect((await d.plan(task, [])).squash).toBeNull();
    await expect(deliver(d, task, runRow, { squash: true })).rejects.toThrow(
      "There is nothing to squash",
    );
  });
});

describe("Jira tasks", () => {
  const jira = {
    branch: "feature/abc-1-fix-login",
    origin: { kind: "jira-issue" as const, key: "ABC-1", connectionId: null },
  };

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
        body: "Compared passwords strictly.",
      },
      {
        kind: "jira-comment",
        key: "ABC-1",
        url: "https://acme.atlassian.net/browse/ABC-1",
        body: "Compared passwords strictly.",
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
    expect(ports.commentOnJiraIssue).toHaveBeenCalledWith(task, "Compared passwords strictly.");
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
      { kind: "pr-comment", url: pr.url, body: "Compared passwords strictly." },
    ]);
    expect(plan.squash).toMatchObject({ commits: 2 });

    await deliver(d, task, runRow, { actions: ["push-branch", "pr-comment"], squash: true });
    expect(subjects(originPath, "feature/pr")).toEqual(["Fix login", "author's work", "initial"]);
    expect(ports.commentOnPullRequest).toHaveBeenCalledWith(task, "Compared passwords strictly.");
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

    const plan = await d.plan(task, []);
    expect(plan).toEqual({
      actions: [{ kind: "pr-review", url: pr.url, findingIds: [kept!.id, dropped!.id] }],
      squash: null,
      completed: [],
    });

    await expect(
      deliver(d, task, runRow, { actions: ["pr-review"], findingIds: [ignored!.id] }),
    ).rejects.toThrow(InvalidGateResponseError);
    await deliver(d, task, runRow, { actions: ["pr-review"], findingIds: [kept!.id] });
    expect(ports.reviewPullRequest).toHaveBeenCalledWith(task, [
      expect.objectContaining({ id: kept!.id }),
    ]);
  });
});
