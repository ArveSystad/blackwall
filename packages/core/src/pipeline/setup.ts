import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitService } from "../git/service.js";
import { SETUP_LOCKFILES } from "../repos/checks.js";
import { runCheckCommand, type CheckRunner } from "./checks.js";
import type { StageContext } from "./engine.js";
import {
  CHECK_FINISHED_EVENT,
  CHECK_STARTED_EVENT,
  fence,
  finishStep,
  logEvent,
  startHarnessStep,
  type CheckFinished,
} from "./stages.js";

/** File in the worktree's own git directory holding the key of its last successful setup. */
export const SETUP_STAMP = "blackwall-setup";

/** Step event a setup harness step logs before it runs the repo's setup commands. */
export const SETUP_STARTED_EVENT = "setup.started";

/** Step event a harness step logs when the worktree's setup is current. */
export const SETUP_SKIPPED_EVENT = "setup.skipped";

/** Payload of a {@link SETUP_STARTED_EVENT} event. */
export interface SetupStarted {
  key: string;
  commands: string[];
}

/** Payload of a {@link SETUP_SKIPPED_EVENT} event. */
export interface SetupSkipped {
  key: string;
}

/** Setup output kept in the implementer's prompt: the tail, where install errors are. */
const MAX_SETUP_FAILURE_OUTPUT_CHARS = 4_000;

/**
 * What decides whether a worktree needs setup again: a SHA-256 over the
 * commands and every {@link SETUP_LOCKFILES} file in the worktree (tracked or
 * untracked, not ignored, at any depth), whatever commands the user typed.
 */
export async function setupKey(
  git: Pick<GitService, "listFiles">,
  worktree: string,
  commands: readonly string[],
): Promise<string> {
  const files = await git.listFiles(
    worktree,
    SETUP_LOCKFILES.map((name) => `:(glob)**/${name}`),
  );
  const hash = createHash("sha256").update(JSON.stringify(commands));
  for (const file of files.sort()) {
    hash.update(`\0${file}\0`);
    try {
      hash.update(await readFile(join(worktree, file)));
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
}

/** How the engine sets up a task's worktree; a port so tests can fake it. */
export interface WorktreeSetup {
  key(worktree: string, commands: readonly string[]): Promise<string>;
  /** The key of the worktree's last successful setup; null when there is none or it can't be read. */
  readStamp(worktree: string): Promise<string | null>;
  writeStamp(worktree: string, key: string): Promise<void>;
  /** Runs one setup command, like a check command. */
  run: CheckRunner;
}

export interface WorktreeSetupOptions {
  git: Pick<GitService, "listFiles" | "gitPath">;
  runCheck?: CheckRunner;
}

/**
 * Worktree setup on disk: the key from {@link setupKey}, and the stamp in the
 * worktree's own git directory (`git rev-parse --git-path blackwall-setup`),
 * so it never shows up in the diff.
 */
export function createWorktreeSetup({
  git,
  runCheck = runCheckCommand,
}: WorktreeSetupOptions): WorktreeSetup {
  return {
    key: (worktree, commands) => setupKey(git, worktree, commands),
    async readStamp(worktree) {
      try {
        const stamp = (await readFile(await git.gitPath(worktree, SETUP_STAMP), "utf8")).trim();
        return stamp || null;
      } catch {
        return null;
      }
    },
    async writeStamp(worktree, key) {
      await writeFile(await git.gitPath(worktree, SETUP_STAMP), `${key}\n`);
    },
    run: runCheck,
  };
}

function describeHow(check: CheckFinished): string {
  const how = check.timedOut ? "timed out" : `exited with code ${check.exitCode ?? "unknown"}`;
  return `\`${check.command}\` ${how}`;
}

/** A failed setup command for the implementer: what failed and the end of its output. */
export function describeSetupFailure(check: CheckFinished): string {
  const output = check.output.slice(-MAX_SETUP_FAILURE_OUTPUT_CHARS);
  return output.trim() ? `${describeHow(check)}:\n\n${fence(output)}` : describeHow(check);
}

/**
 * Runs the repo's setup commands in the task's worktree as one harness step
 * of the current stage visit, logged like checks (`check.started`,
 * `check.finished`) after a {@link SETUP_STARTED_EVENT}. Stops at the first
 * failure and writes the stamp only when every command passed. Resolves with
 * undefined on success, else with what went wrong; an abort leaves the step
 * `interrupted`. Never throws.
 */
export async function runSetupStep(
  ctx: StageContext,
  setup: WorktreeSetup,
  key: string,
  commands: string[],
): Promise<string | undefined> {
  const { signal } = ctx;
  let stepId: string | undefined;
  try {
    const worktree = ctx.task.worktreePath;
    if (!worktree) throw new Error("The task has no worktree");
    const step = startHarnessStep(ctx);
    stepId = step.id;
    logEvent(ctx, step.id, SETUP_STARTED_EVENT, { key, commands } satisfies SetupStarted);
    for (const command of commands) {
      logEvent(ctx, step.id, CHECK_STARTED_EVENT, { command });
      const outcome = await setup.run(command, { cwd: worktree, signal });
      if (signal.aborted) throw new Error("Interrupted");
      const finished: CheckFinished = { command, ...outcome };
      logEvent(ctx, step.id, CHECK_FINISHED_EVENT, finished);
      if (outcome.exitCode !== 0) {
        finishStep(ctx, step.id, { status: "failed", error: describeHow(finished) });
        return describeSetupFailure(finished);
      }
    }
    try {
      await setup.writeStamp(worktree, key);
    } catch {
      // A missing stamp only costs running setup again on the next drive.
    }
    finishStep(ctx, step.id, { status: "succeeded", error: null });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stepId) {
      try {
        finishStep(ctx, stepId, {
          status: signal.aborted ? "interrupted" : "failed",
          error: message,
        });
      } catch {
        // The step stays as it was; the failure is still reported.
      }
    }
    return message;
  }
}
