import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHECK_RETRIES, type Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DB_FILENAME } from "../db/database.js";
import { GitError, createGitService } from "../git/service.js";
import { ARTIFACTS_DIR } from "./artifacts.js";
import type { FakeScript } from "./fake-adapter.js";
import { createDeliverer, type DeliveryGit, type DeliveryPorts } from "./delivery.js";
import type { CheckOutcome, CheckRunner } from "./checks.js";
import {
  CHECKS_SKIPPED_EVENT,
  commitKey,
  commitMessage,
  isDocsPath,
  type ChecksGit,
} from "./stages.js";
import { copySeedRepo } from "../testing/index.js";
import {
  closeEngineTest,
  openEngineTest,
  createDefaultStages,
  type Call,
  type Harness,
  harness,
  agentService,
  seedTask,
  task,
  settle,
  prOrigin,
  stepsOf,
  lastStep,
  dir,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

describe("implement and checks", () => {
  const failing = (output: string): CheckOutcome => ({ exitCode: 1, output, timedOut: false });
  const passing: CheckOutcome = { exitCode: 0, output: "ok", timedOut: false };

  /** A task approved for implementation, in a repo with these check commands. */
  async function approved(
    h: Harness,
    checkCommands: string[],
    patch: Parameters<typeof seedTask>[0] = {},
  ) {
    const seeded = seedTask(patch);
    r.repos.update(seeded.repoId, { checkCommands });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    return seeded;
  }

  const afterApproval = (h: Harness) =>
    h.calls.slice(h.calls.findIndex((c) => c.stage === "implement")).map((c) => c.stage);

  const checkSteps = (taskId: string) =>
    stepsOf(taskId).filter((s) => s.stage === "checks" && s.agentId === null);

  const noFindings = (stage: Call): FakeScript =>
    stage === "code-review" ? { structured: { findings: [] } } : {};

  it("lists the repo's check commands in the implement prompt", async () => {
    const runCheck = vi.fn(async () => passing);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    await approved(h, ["pnpm run test", "pnpm run lint"]);
    const implement = h.calls.find((c) => c.stage === "implement")!.options.prompt;
    expect(implement).toContain("## Checks the harness runs");
    expect(implement).toContain("- `pnpm run test`\n- `pnpm run lint`");
    expect(implement).toContain("sends any failure back to you");
    expect(implement).toContain("Run only fast, targeted builds and tests");
  });

  it("leaves the check commands out of the implement prompt when the repo has none", async () => {
    const runCheck = vi.fn(async () => passing);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    await approved(h, []);
    const implement = h.calls.find((c) => c.stage === "implement")!.options.prompt;
    expect(implement).not.toContain("## Checks the harness runs");
  });

  it("retries the implementer with the failing output before any reviewer runs", async () => {
    const results = [failing("FAIL src/login.test.ts\n  expected 401"), passing, passing];
    const runCheck = vi.fn<CheckRunner>(async () => results.shift()!);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, ["pnpm run test", "pnpm run lint"]);

    expect(afterApproval(h)).toEqual([
      "implement",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const retry = h.calls.filter((c) => c.stage === "implement")[1]!.options.prompt;
    expect(retry).toContain("`pnpm run test` exited with code 1");
    expect(retry).toContain("expected 401");
    expect(retry).toContain("Your changes fail the check above");
    expect(retry).toContain("## Checks the harness runs");
    // The first run stops at the failing command; the retry runs both.
    expect(runCheck.mock.calls.map(([command]) => command)).toEqual([
      "pnpm run test",
      "pnpm run test",
      "pnpm run lint",
    ]);
    expect(runCheck.mock.calls[0]![1].cwd).toBe(dir);
    expect(checkSteps(seeded.id).map((s) => [s.status, s.round])).toEqual([
      ["failed", 0],
      ["succeeded", 0],
    ]);
    expect(checkSteps(seeded.id)[0]!.error).toBe("`pnpm run test` exited with code 1");
    expect(r.findings.listByTask(seeded.id)).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("turns a failure that survives the retry into a Critical correctness finding", async () => {
    let checks = 0;
    // Fails in round 0 (first pass and retry); passes once the fix round runs.
    const runCheck = vi.fn(async () => (++checks <= 2 ? failing("tsc: TS2322") : passing));
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, ["pnpm run typecheck"]);

    // The panel saw the change only after the implementer's retry.
    expect(afterApproval(h)).toEqual([
      "implement",
      "implement",
      "code-review",
      "code-review",
      "implement",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const [finding] = r.findings.listByTask(seeded.id);
    expect(finding).toMatchObject({
      severity: "critical",
      tags: ["correctness"],
      title: "Check failed: pnpm run typecheck",
      reviewerAgentId: null,
      stepId: checkSteps(seeded.id)[1]!.id,
      round: 0,
      status: "fixed",
    });
    expect(finding!.explanation).toContain("still after 1 implementer retry");
    expect(finding!.explanation).toContain("tsc: TS2322");
    // The fix round got the finding, not the stale check output.
    const fix = h.calls.filter((c) => c.stage === "implement")[2]!.options.prompt;
    expect(fix).toContain("Check failed: pnpm run typecheck");
    expect(fix).not.toContain("Your changes fail the check above");
    expect(checkSteps(seeded.id).map((s) => [s.status, s.round])).toEqual([
      ["failed", 0],
      ["failed", 0],
      ["succeeded", 1],
    ]);
    expect(h.events.some((e) => e.type === "finding.upserted")).toBe(true);
    expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
  });

  it("skips the checks when the repo has no check commands", async () => {
    const runCheck = vi.fn(async () => passing);
    const h = harness(noFindings, { stages: createDefaultStages({ runCheck }) });
    const seeded = await approved(h, []);
    expect(runCheck).not.toHaveBeenCalled();
    expect(checkSteps(seeded.id)).toEqual([]);
    expect(task(seeded.id)).toMatchObject({ gate: "finish" });
  });

  describe("skipping on the branch's changes", () => {
    const checksGit = (changedFiles: () => Promise<string[]>): ChecksGit => ({
      mergeBase: async () => "base",
      commitsSince: async () => 0,
      changedFiles,
    });

    const skipped = (taskId: string) =>
      checkSteps(taskId).flatMap((s) =>
        r.stepEvents
          .list(s.id)
          .filter((e) => e.type === CHECKS_SKIPPED_EVENT)
          .map((e) => e.payload),
      );

    it("skips the checks when the branch changes no files", async () => {
      const runCheck = vi.fn(async () => passing);
      const stages = createDefaultStages({ runCheck, checksGit: checksGit(async () => []) });
      const h = harness(noFindings, { stages });
      const seeded = await approved(h, ["pnpm test"]);

      expect(runCheck).not.toHaveBeenCalled();
      expect(checkSteps(seeded.id).map((s) => s.status)).toEqual(["succeeded"]);
      expect(skipped(seeded.id)).toEqual([{ reason: "no-changes", files: [] }]);
      expect(task(seeded.id)).toMatchObject({ gate: "finish" });
    });

    it("skips the checks when the branch changes only docs", async () => {
      const files = ["README.md", "docs/guide/setup.txt", "packages/x/CHANGELOG.MD"];
      const runCheck = vi.fn(async () => passing);
      const stages = createDefaultStages({ runCheck, checksGit: checksGit(async () => files) });
      const h = harness(noFindings, { stages });
      const seeded = await approved(h, ["pnpm test"]);

      expect(runCheck).not.toHaveBeenCalled();
      expect(skipped(seeded.id)).toEqual([{ reason: "docs-only", files }]);
      expect(task(seeded.id)).toMatchObject({ gate: "finish" });
    });

    it("runs the checks when the branch changes code too", async () => {
      const runCheck = vi.fn<CheckRunner>(async () => passing);
      const stages = createDefaultStages({
        runCheck,
        checksGit: checksGit(async () => ["README.md", "src/a.ts"]),
      });
      const h = harness(noFindings, { stages });
      const seeded = await approved(h, ["pnpm test"]);

      expect(runCheck).toHaveBeenCalledWith("pnpm test", expect.anything());
      expect(skipped(seeded.id)).toEqual([]);
    });

    it("runs the checks when the fork point can't be found", async () => {
      const runCheck = vi.fn<CheckRunner>(async () => passing);
      const stages = createDefaultStages({
        runCheck,
        checksGit: {
          mergeBase: async () => {
            throw new Error("no merge base");
          },
          commitsSince: async () => 0,
          changedFiles: async () => [],
        },
      });
      const h = harness(noFindings, { stages });
      await approved(h, ["pnpm test"]);

      expect(runCheck).toHaveBeenCalledWith("pnpm test", expect.anything());
    });
  });

  it("counts Markdown files and the root docs folder as docs paths", () => {
    for (const path of ["a.md", "x/y.MD", "docs/img.png"]) expect(isDocsPath(path)).toBe(true);
    for (const path of ["src/docs/a.ts", "docs.ts", "a.mdx"]) expect(isDocsPath(path)).toBe(false);
  });

  it("fails the task with what to do when the commit hits a git lock", async () => {
    const git = {
      stagedDiff: async () => "diff --git a/a.ts b/a.ts\n+x",
      commitAll: async (): Promise<string> => {
        throw new GitError(
          ["add", "-A"],
          "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running\n",
          128,
        );
      },
    };
    const h = harness(noFindings, { stages: createDefaultStages({ git }) });
    const seeded = await approved(h, []);

    // The commit runs after the commit message step succeeded, so the task carries the failure.
    const failed = task(seeded.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^Another git process holds \/repo\/\.git\/index\.lock\./);
    expect(failed.error).not.toContain("git add -A failed");
  });

  it("commits each round with the summarizer's message, the Jira key after the type", async () => {
    const diffs = ["diff --git a/src/login.ts b/src/login.ts\n+if (a === b)"];
    const git = {
      stagedDiff: vi.fn<(worktree: string) => Promise<string>>(async () => diffs.shift() ?? ""),
      commitAll: vi.fn<(worktree: string, message: string) => Promise<string>>(
        async () => "abc123",
      ),
    };
    const h = harness(
      (stage) =>
        stage === "commit"
          ? { text: "```\nfix(auth): compare passwords strictly\n\nUse ===.\n```" }
          : noFindings(stage),
      { stages: createDefaultStages({ git }) },
    );
    const seeded = await approved(h, [], {
      origin: { kind: "jira-issue", key: "ABC-123", connectionId: null },
      branch: "feature/abc-123-login",
    });

    expect(afterApproval(h)).toEqual([
      "implement",
      "commit",
      "code-review",
      "code-review",
      "summarize",
    ]);
    const commitCall = h.calls.find((c) => c.stage === "commit")!;
    expect(commitCall.options.prompt).toContain("+if (a === b)");
    expect(commitCall.options.prompt).toContain("Do not mention ABC-123");
    expect(commitCall.options.prompt).toContain("Conventional Commits");
    expect(git.stagedDiff).toHaveBeenCalledWith(dir);
    expect(git.commitAll).toHaveBeenCalledTimes(1);
    expect(git.commitAll).toHaveBeenCalledWith(
      dir,
      "fix(auth): ABC-123 compare passwords strictly\n\nUse ===.",
    );
    // The summarizer's step belongs to Checks.
    const commitStep = stepsOf(seeded.id).find(
      (s) => s.stage === "checks" && s.agentId === seeded.agents.summarizer,
    );
    expect(commitStep).toMatchObject({ status: "succeeded", round: 0 });
  });

  it("commits with a conventional fallback message when the summarizer replies with nothing", async () => {
    const diffs = ["diff --git a/src/login.ts b/src/login.ts\n+if (a === b)"];
    const git = {
      stagedDiff: async () => diffs.shift() ?? "",
      commitAll: vi.fn<(worktree: string, message: string) => Promise<string>>(
        async () => "abc123",
      ),
    };
    const h = harness((stage) => (stage === "commit" ? { text: "" } : noFindings(stage)), {
      stages: createDefaultStages({ git }),
    });
    await approved(h, []);
    expect(git.commitAll).toHaveBeenCalledWith(dir, "chore: implement the approved plan");
  });

  it("never commits artifacts, even when the scratch .gitignore was deleted", async () => {
    const run = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    copySeedRepo(dir, { files: { ".gitignore": `${DB_FILENAME}*\n` } });

    const h = harness(
      (stage) => {
        if (stage === "implement") {
          mkdirSync(join(dir, ARTIFACTS_DIR), { recursive: true });
          writeFileSync(join(dir, ARTIFACTS_DIR, "home.png"), "png");
          rmSync(join(dir, ".blackwall", ".gitignore"), { force: true });
          writeFileSync(join(dir, "login.ts"), "export {};\n");
        }
        return noFindings(stage);
      },
      { stages: createDefaultStages({ git: createGitService() }) },
    );
    await approved(h, []);

    const committed = run("show", "--name-only", "--format=", "HEAD").trim().split("\n");
    expect(committed).toEqual(["login.ts"]);
    expect(run("ls-files")).not.toContain(".blackwall");
  });

  describe("commit hooks", () => {
    const DIFF = "diff --git a/a.ts b/a.ts\n+x";
    const commitMsgRejection = (message: string) =>
      new GitError(["commit", "--quiet", "-m", message], "✖ subject must be conventional", 1, {
        hook: "commit-msg",
      });
    const preCommitRejection = () =>
      new GitError(["commit"], "husky - pre-commit script failed (code 1)", 1, {
        stdout: "eslint: 'x' is assigned a value but never used",
        hook: "pre-commit",
      });

    /** Commit stand-ins whose hooks reject a message when `reject` returns an error. */
    function hookedGit(reject: (message: string) => GitError | undefined) {
      let committed = false;
      return {
        stagedDiff: vi.fn(async () => (committed ? "" : DIFF)),
        commitAll: vi.fn<(worktree: string, message: string) => Promise<string>>(
          async (_worktree, message) => {
            const error = reject(message);
            if (error) throw error;
            committed = true;
            return "abc123";
          },
        ),
      };
    }

    const conventional = (message: string) =>
      /^feat: /.test(message) ? undefined : commitMsgRejection(message);

    const prompts = (h: Harness, stage: Call, from = 0) =>
      h.calls
        .slice(from)
        .filter((c) => c.stage === stage)
        .map((c) => c.options.prompt);

    const summarizerSteps = (seeded: Task) =>
      stepsOf(seeded.id).filter(
        (s) => s.stage === "checks" && s.agentId === seeded.agents.summarizer,
      );

    it("has the summarizer rewrite a message a real commit-msg hook rejects", async () => {
      const run = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      copySeedRepo(dir, { files: { ".gitignore": `${DB_FILENAME}*\n` } });
      const hooks = join(dir, run("rev-parse", "--git-path", "hooks").trim());
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        join(hooks, "commit-msg"),
        `#!/bin/sh\ngrep -qE '^feat: ' "$1" || { echo "subject must start with feat:" >&2; exit 1; }\n`,
        { mode: 0o755 },
      );

      const h = harness(
        (stage) => {
          if (stage === "implement") writeFileSync(join(dir, "login.ts"), "export {};\n");
          if (stage === "commit") return { text: "Add login" };
          if (stage === "commit-rewrite") return { text: "feat: add login" };
          return noFindings(stage);
        },
        { stages: createDefaultStages({ git: createGitService() }) },
      );
      const seeded = await approved(h, []);

      expect(afterApproval(h)).toEqual([
        "implement",
        "commit",
        "commit-rewrite",
        "code-review",
        "code-review",
        "summarize",
      ]);
      const [rewrite] = prompts(h, "commit-rewrite");
      expect(rewrite).toContain("Add login");
      expect(rewrite).toContain("subject must start with feat:");
      expect(run("log", "-1", "--format=%s").trim()).toBe("feat: add login");
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });

    it("fails after 3 rewrites, then resumes from the original message", async () => {
      let accept = false;
      let rewrites = 0;
      const git = hookedGit(conventional);
      const h = harness(
        (stage) => {
          if (stage === "commit") return { text: "Add login" };
          if (stage === "commit-rewrite") {
            return { text: accept ? "feat: add login" : `Still wrong ${++rewrites}` };
          }
          return noFindings(stage);
        },
        { stages: createDefaultStages({ git }) },
      );
      const seeded = await approved(h, []);

      const failed = task(seeded.id);
      expect(failed.status).toBe("failed");
      expect(afterApproval(h)).toEqual([
        "implement",
        "commit",
        "commit-rewrite",
        "commit-rewrite",
        "commit-rewrite",
      ]);
      expect(failed.error).toContain("The repo's commit-msg hook rejected the commit message.");
      expect(failed.error).toContain("subject must be conventional");
      const rejected = prompts(h, "commit-rewrite");
      expect(rejected[0]).toContain("Add login");
      expect(rejected[1]).toContain("Still wrong 1");
      expect(rejected[2]).toContain("Still wrong 2");
      expect(git.commitAll.mock.calls.map(([, message]) => message)).toEqual([
        "chore: Add login",
        "chore: Still wrong 1",
        "chore: Still wrong 2",
        "chore: Still wrong 3",
      ]);

      accept = true;
      const before = h.calls.length;
      h.engine.resume(seeded.id);
      await settle(h.engine);

      // The original summarizer step's message is reused, not asked for again.
      expect(h.calls.slice(before).map((c) => c.stage)).toEqual([
        "commit-rewrite",
        "code-review",
        "code-review",
        "summarize",
      ]);
      const [again] = prompts(h, "commit-rewrite", before);
      expect(again).toContain("Add login");
      expect(again).not.toContain("Still wrong 3");
      expect(git.commitAll).toHaveBeenLastCalledWith(dir, "feat: add login");
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });

    it("starts a new rewrite after one was interrupted", async () => {
      let hang = true;
      const git = hookedGit(conventional);
      const h = harness(
        (stage) => {
          if (stage === "commit") return { text: "Add login" };
          if (stage === "commit-rewrite") {
            return hang ? { hang: true, sessionId: "rewrite-1" } : { text: "feat: add login" };
          }
          return noFindings(stage);
        },
        { stages: createDefaultStages({ git }) },
      );
      const seeded = seedTask();
      r.repos.update(seeded.repoId, { checkCommands: [] });
      h.engine.enqueue(seeded.id);
      await settle(h.engine);
      await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
      await vi.waitFor(() => expect(lastStep(seeded.id)?.sessionId).toBe("rewrite-1"));

      await h.engine.stop(seeded.id);
      hang = false;
      const before = h.calls.length;
      h.engine.resume(seeded.id);
      await settle(h.engine);

      const resumed = h.calls.slice(before);
      expect(resumed.some((c) => c.options.resumeSessionId === "rewrite-1")).toBe(false);
      expect(resumed.map((c) => c.stage)).toEqual([
        "commit-rewrite",
        "code-review",
        "code-review",
        "summarize",
      ]);
      expect(resumed[0]!.options.prompt).toContain("Add login");
      expect(summarizerSteps(seeded).map((s) => s.status)).toEqual([
        "succeeded",
        "interrupted",
        "succeeded",
      ]);
      expect(git.commitAll).toHaveBeenLastCalledWith(dir, "feat: add login");
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });

    it("sends a pre-commit rejection back to the implementer as a failed check", async () => {
      let rejections = 1;
      const git = hookedGit(() => (rejections-- > 0 ? preCommitRejection() : undefined));
      const h = harness(noFindings, { stages: createDefaultStages({ git }) });
      const seeded = await approved(h, []);

      expect(afterApproval(h)).toEqual([
        "implement",
        "commit",
        "implement",
        "commit",
        "code-review",
        "code-review",
        "summarize",
      ]);
      const retry = prompts(h, "implement")[1]!;
      expect(retry).toContain("## Failed check");
      expect(retry).toContain("`git commit (pre-commit hook)` exited with code 1");
      expect(retry).toContain("eslint: 'x' is assigned a value but never used");
      const [hookStep, ...rest] = checkSteps(seeded.id);
      expect(rest).toEqual([]);
      expect(hookStep).toMatchObject({ status: "failed", round: 0 });
      expect(hookStep!.error).toMatch(/^The repo's pre-commit hook rejected the commit\./);
      expect(task(seeded.id)).toMatchObject({ status: "needs-you", gate: "finish" });
    });

    it("fails the task when the pre-commit hook still rejects after the retries", async () => {
      const git = hookedGit(preCommitRejection);
      const h = harness(noFindings, { stages: createDefaultStages({ git }) });
      const seeded = await approved(h, ["pnpm run test"]);

      expect(prompts(h, "implement")).toHaveLength(MAX_CHECK_RETRIES + 1);
      const failed = task(seeded.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("The repo's pre-commit hook rejected the commit.");
      expect(failed.error).toContain("eslint: 'x' is assigned a value but never used");
      expect(r.findings.listByTask(seeded.id)).toEqual([]);
      expect(h.calls.some((c) => c.stage === "code-review")).toBe(false);
      expect(checkSteps(seeded.id).every((s) => s.status === "failed")).toBe(true);
    });

    it("commits with a conventional fallback without a summarizer", async () => {
      const git = hookedGit(() => undefined);
      const h = harness(noFindings, { stages: createDefaultStages({ git }) });
      const agents = agentService();
      agents.seed();
      const roles = { ...agents.resolveRoles() };
      delete roles.summarizer;
      await approved(h, [], { agents: roles });
      expect(git.commitAll).toHaveBeenCalledWith(dir, "chore: implement the approved plan");
      expect(h.calls.some((c) => c.stage === "commit")).toBe(false);
    });

    it("saves the squash message the summarizer rewrote at delivery", async () => {
      const squash = vi.fn(async (_worktree: string, _since: string, message: string) => {
        if (!message.startsWith("fix: ")) {
          throw new GitError(["commit"], "type must be fix", 1, { hook: "commit-msg" });
        }
        return "def456";
      });
      const deliveryGit = {
        isProtected: () => false,
        mergeBase: async () => "base",
        commitsSince: async () => 2,
        squash,
        remoteUrl: async () => null,
      } as unknown as DeliveryGit;
      const deliverer = createDeliverer({
        git: deliveryGit,
        repositories: r,
        ports: {} as DeliveryPorts,
      });
      const h = harness(
        (stage) => (stage === "commit-rewrite" ? { text: "fix: login" } : noFindings(stage)),
        { deliver: (ctx) => deliverer.deliver(ctx) },
      );
      const seeded = await approved(h, []);
      expect(task(seeded.id).squashMessage).toBe("chore: Fix login");

      await h.engine.respond(seeded.id, {
        gate: "finish",
        decision: "approve",
        delivery: { actions: [], squash: true },
      });

      expect(squash.mock.calls.map(([, , message]) => message)).toEqual([
        "chore: Fix login",
        "fix: login",
      ]);
      const [rewrite] = prompts(h, "commit-rewrite");
      expect(rewrite).toContain("chore: Fix login");
      expect(rewrite).toContain("type must be fix");
      expect(task(seeded.id).squashMessage).toBe("fix: login");
    });
  });
});

describe("commit messages", () => {
  const withOrigin = (origin: unknown, branch: string | null = null) =>
    ({ origin, branch }) as unknown as Task;

  it("takes the Jira key from a Jira origin or a PR's head branch", () => {
    expect(commitKey(withOrigin({ kind: "jira-issue", key: "ABC-1" }))).toBe("ABC-1");
    expect(commitKey(withOrigin(prOrigin(), "feature/abc-12-login"))).toBe("ABC-12");
    expect(commitKey(withOrigin(prOrigin(), "bugfix"))).toBeUndefined();
    expect(commitKey(withOrigin({ kind: "free-text" }, "agent/abcdef12-3456"))).toBeUndefined();
  });

  const cases: [string, string | undefined, string][] = [
    ["```text\nfeat: add login\n```", "ABC-1", "feat: ABC-1 add login"],
    ["feat(auth)!: drop md5\n\nBody", "ABC-1", "feat(auth)!: ABC-1 drop md5\n\nBody"],
    ["feat: ABC-1 add login", "ABC-1", "feat: ABC-1 add login"],
    ["ABC-1 feat: add login", "ABC-1", "feat: ABC-1 add login"],
    ["abc-1 feat: add login", "ABC-1", "feat: ABC-1 add login"],
    ["PROJ-9 feat: x", undefined, "chore: PROJ-9 feat: x"],
    ["XYZ-2 feat: x", "ABC-1", "chore: ABC-1 XYZ-2 feat: x"],
    ["feat: ABC-10 x", "ABC-1", "feat: ABC-1 ABC-10 x"],
    ["Add login", undefined, "chore: Add login"],
    ["  Add login \n", "ABC-1", "chore: ABC-1 Add login"],
    ["ABC-1 Fix login", "ABC-1", "chore: ABC-1 Fix login"],
    ["Feat: x", undefined, "feat: x"],
    ["docs: y", undefined, "docs: y"],
    ["wip: y", undefined, "chore: wip: y"],
  ];

  it("normalises the message to Conventional Commits with the key after the type", () => {
    for (const [text, key, expected] of cases) expect(commitMessage(text, key)).toBe(expected);
  });

  it("leaves a normalised message unchanged", () => {
    for (const [text, key] of cases) {
      const once = commitMessage(text, key);
      expect(commitMessage(once, key)).toBe(once);
    }
  });
});
