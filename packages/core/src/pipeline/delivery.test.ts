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
        message: "Fix login",
      });
    });

    it("still offers the push and comment without a new commit, but no PR or squash", async () => {
      const { d, task } = await pushed(["push-branch", "open-pr", "issue-comment"]);
      const plan = await d.plan(task, []);
      expect(kinds(plan.actions)).toEqual(["push-branch", "issue-comment"]);
      expect(plan.squash).toBeNull();
    });

    it("still offers open-pr after a push that opened none", async () => {
      const { d, task } = await pushed(["push-branch"]);
      const plan = await d.plan(task, []);
      expect(kinds(plan.actions)).toEqual(["push-branch", "open-pr", "issue-comment"]);
      expect(plan.squash).toBeNull();
    });
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
    expect(subjects(originPath, "feature/pr")).toEqual(["Fix login", "author's work", "initial"]);
    expect(ports.commentOnPullRequest).toHaveBeenCalledWith(task, "Logins reject wrong passwords.");
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
