import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "../agents/adapters/types.js";
import { createGitService, type GitService } from "../git/service.js";
import type { FakeScript } from "./fake-adapter.js";
import { copySeedRepo } from "../testing/index.js";
import {
  closeEngineTest,
  openEngineTest,
  createDefaultStages,
  type Call,
  type Harness,
  harness,
  seedTask,
  task,
  settle,
  stepsOf,
  r,
} from "./engine-harness.js";

beforeEach(openEngineTest);
afterEach(closeEngineTest);

// Full runs against a real repo with worktree snapshots: ~7s each alone on Windows,
// over 20s under a full test run.
describe("read-only backstop under Trusted", { timeout: 45_000 }, () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const realGit = createGitService();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "blackwall-backstop-"));
    copySeedRepo(repo, { files: { "login.ts": "if (a == b) {}\n" } });
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function backstopHarness(
    script: (stage: Call, options: AgentRunOptions) => FakeScript,
    worktreeGuard: Pick<GitService, "snapshotWorktree" | "restoreWorktree"> = realGit,
  ) {
    return harness(
      (stage, options) => {
        if (stage === "implement") writeFileSync(join(repo, "login.ts"), "if (a === b) {}\n");
        return script(stage, options);
      },
      {
        stages: createDefaultStages({ git: realGit }),
        prepareWorkspace: async (t) => ({ branch: `agent/${t.id}`, worktreePath: repo }),
        worktreeGuard,
      },
    );
  }

  async function approvedTrusted(h: Harness) {
    const seeded = seedTask();
    r.repos.update(seeded.repoId, { agentTrust: "trusted" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    return seeded;
  }

  it("lets a Trusted summarizer that leaves the staged round alone commit it", async () => {
    const h = backstopHarness((stage) =>
      stage === "commit" ? { text: "fix(auth): compare strictly" } : {},
    );
    const seeded = await approvedTrusted(h);
    expect(git("log", "-1", "--format=%s").trim()).toBe("fix(auth): compare strictly");
    const commitStep = stepsOf(seeded.id).find(
      (s) => s.stage === "checks" && s.agentId === seeded.agents.summarizer,
    );
    expect(commitStep).toMatchObject({ status: "succeeded", trust: "trusted" });
  });

  it("undoes a Trusted summarizer's edit to the staged round and fails the step", async () => {
    writeFileSync(join(repo, "notes.txt"), "untracked notes\n");
    const h = backstopHarness((stage) => {
      if (stage === "commit") {
        writeFileSync(join(repo, "login.ts"), "tampered\n");
        writeFileSync(join(repo, "extra.txt"), "planted\n");
        rmSync(join(repo, "notes.txt"));
      }
      return {};
    });
    const seeded = await approvedTrusted(h);
    const commitStep = stepsOf(seeded.id).find(
      (s) => s.stage === "checks" && s.agentId === seeded.agents.summarizer,
    );
    expect(commitStep).toMatchObject({
      status: "failed",
      error: "A read-only agent changed the worktree under Trusted",
      trust: "trusted",
    });
    expect(task(seeded.id)).toMatchObject({
      status: "failed",
      error: "A read-only agent changed the worktree under Trusted",
    });
    // The round is back as the harness staged it (notes.txt too), and nothing was committed.
    expect(git("log", "--format=%s").trim()).toBe("initial");
    expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual([
      "login.ts",
      "notes.txt",
    ]);
    expect(git("show", ":login.ts")).toBe("if (a === b) {}\n");
    expect(readFileSync(join(repo, "login.ts"), "utf8")).toBe("if (a === b) {}\n");
    expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("untracked notes\n");
    expect(existsSync(join(repo, "extra.txt"))).toBe(false);
  });

  it("undoes a file a Trusted reviewer created on a clean tree and fails its step", async () => {
    const h = backstopHarness((stage) => {
      if (stage === "code-review") {
        writeFileSync(join(repo, "pwned.txt"), "x\n");
        return { structured: { findings: [] } };
      }
      return {};
    });
    const seeded = await approvedTrusted(h);
    const reviewSteps = stepsOf(seeded.id).filter(
      (s) => s.stage === "code-review" && s.agentId !== null,
    );
    expect(reviewSteps.some((s) => s.status === "failed")).toBe(true);
    expect(reviewSteps.find((s) => s.status === "failed")?.error).toBe(
      "A read-only agent changed the worktree under Trusted",
    );
    expect(existsSync(join(repo, "pwned.txt"))).toBe(false);
    expect(git("status", "--porcelain").trim()).toBe("");
  });

  it("lets an in-repo task's Trusted reviewer change the folder, without the guard", async () => {
    const guard = {
      snapshotWorktree: vi.fn(realGit.snapshotWorktree),
      restoreWorktree: vi.fn(realGit.restoreWorktree),
    };
    const h = backstopHarness((stage) => {
      if (stage === "code-review") {
        writeFileSync(join(repo, "mine.txt"), "x\n");
        return { structured: { findings: [] } };
      }
      return {};
    }, guard);
    const seeded = seedTask({ inRepo: true });
    r.repos.update(seeded.repoId, { agentTrust: "trusted" });
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);

    const reviewSteps = stepsOf(seeded.id).filter(
      (s) => s.stage === "code-review" && s.agentId !== null,
    );
    expect(reviewSteps.length).toBeGreaterThan(0);
    expect(reviewSteps.every((s) => s.status === "succeeded")).toBe(true);
    expect(task(seeded.id).status).not.toBe("failed");
    expect(existsSync(join(repo, "mine.txt"))).toBe(true);
    expect(guard.snapshotWorktree).not.toHaveBeenCalled();
    expect(guard.restoreWorktree).not.toHaveBeenCalled();
  });

  it("never runs the guard on a worktree twice at once while the panel reviews", async () => {
    let running = 0;
    let overlapped = false;
    const exclusive =
      <A extends unknown[], T>(fn: (...args: A) => Promise<T>) =>
      async (...args: A): Promise<T> => {
        overlapped ||= running > 0;
        running++;
        try {
          return await fn(...args);
        } finally {
          running--;
        }
      };
    const h = backstopHarness(
      (stage) => {
        if (stage === "code-review") {
          writeFileSync(join(repo, "pwned.txt"), "x\n");
          return { structured: { findings: [] } };
        }
        return {};
      },
      {
        snapshotWorktree: exclusive(realGit.snapshotWorktree),
        restoreWorktree: exclusive(realGit.restoreWorktree),
      },
    );
    const seeded = await approvedTrusted(h);
    expect(overlapped).toBe(false);
    const reviewSteps = stepsOf(seeded.id).filter(
      (s) => s.stage === "code-review" && s.agentId !== null,
    );
    expect(reviewSteps.length).toBeGreaterThan(1);
    expect(reviewSteps.some((s) => s.status === "failed")).toBe(true);
    expect(existsSync(join(repo, "pwned.txt"))).toBe(false);
  });

  it("leaves Locked read-only steps alone", async () => {
    const h = backstopHarness((stage) => {
      if (stage === "commit") writeFileSync(join(repo, "extra.txt"), "planted\n");
      return stage === "commit" ? { text: "fix: x" } : {};
    });
    const seeded = seedTask();
    h.engine.enqueue(seeded.id);
    await settle(h.engine);
    await h.engine.respond(seeded.id, { gate: "plan-approval", decision: "approve" });
    await settle(h.engine);
    // No backstop under Locked: the file the summarizer planted stays (Locked's flags stop it).
    expect(existsSync(join(repo, "extra.txt"))).toBe(true);
  });
});
