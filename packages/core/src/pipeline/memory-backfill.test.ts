import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@blackwall/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentService, type AgentService } from "../agents/service.js";
import { openDatabase, type OpenedDatabase } from "../db/database.js";
import { createRepositories, type Repositories } from "../db/repositories.js";
import { memoryBackfillKey } from "../settings/service.js";
import { createFakeAdapter, type FakeScript } from "./fake-adapter.js";
import {
  createMemoryBackfill,
  eligibleTasks,
  MemoryBackfillBusyError,
  memoryBackfillPrompt,
  type MemoryBackfillOptions,
} from "./memory-backfill.js";
import type { PullRequestMergeState } from "./memory-release.js";

let dir: string;
let opened: OpenedDatabase;
let r: Repositories;
let agents: AgentService;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blackwall-memory-backfill-"));
  opened = openDatabase(dir);
  r = createRepositories(opened.db);
  agents = createAgentService({
    agents: r.agents,
    settings: r.settings,
    tags: r.tags,
    repos: r.repos,
    tasks: r.tasks,
    backlogItems: r.backlogItems,
    transaction: r.transaction,
  });
  agents.seed();
  repoId = r.repos.create({ path: "/code/app", name: "app", defaultBranch: "develop" }).id;
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

/** A finished task with a summary, on the default agents. */
function doneTask(
  title: string,
  extra: Partial<Parameters<Repositories["tasks"]["create"]>[0]> = {},
) {
  return r.tasks.create({
    title,
    origin: { kind: "free-text" },
    repoId,
    status: "done",
    summary: `Summary of ${title}`,
    agents: agents.resolveRoles(),
    ...extra,
  });
}

function prTask(title: string, number: number): Task {
  return doneTask(title, { origin: prOrigin(number), mode: "work" });
}

const reply = (...texts: string[]): FakeScript => ({
  structured: { memories: texts.map((text) => ({ kind: "convention", text })) },
});

const open: PullRequestMergeState = { state: "open", merged: false, baseRef: "develop" };

function setup({
  script,
  ...options
}: Partial<MemoryBackfillOptions> & { script?: (call: number) => FakeScript } = {}) {
  const claude = createFakeAdapter("claude", (_, call) => script?.(call) ?? reply());
  const log = vi.fn<(message: string) => void>();
  const prMergeState = vi.fn(options.prMergeState ?? (async () => open));
  const backfill = createMemoryBackfill({
    repositories: r,
    adapters: { claude },
    agents,
    log,
    ...options,
    prMergeState,
  });
  const finish = () => vi.waitFor(() => expect(backfill.status(repoId).running).toBe(false));
  const run = async () => {
    backfill.start(repoId);
    await finish();
    return backfill.status(repoId);
  };
  return { backfill, claude, log, prMergeState, run, finish };
}

const processed = () =>
  (r.settings.get<{ taskIds: string[] }>(memoryBackfillKey(repoId))?.taskIds ?? []).sort();
const notes = (taskId: string) =>
  [...r.memories.listByRepo(repoId), ...r.memories.listAwaitingByRepo(repoId)]
    .filter((m) => m.sourceTaskId === taskId)
    .map((m) => ({ text: m.text, awaitingMerge: m.awaitingMerge }));

describe("eligibleTasks", () => {
  it("keeps the repo's done tasks with a summary, archived ones too, oldest first", () => {
    const first = doneTask("First");
    doneTask("Running", { status: "running" });
    doneTask("No summary", { summary: "  " });
    doneTask("Review", { origin: prOrigin(1), mode: "review" });
    const other = r.repos.create({ path: "/code/other", name: "other" });
    doneTask("Elsewhere", { repoId: other.id });
    const archived = doneTask("Archived", { archivedAt: new Date() });
    const handled = doneTask("Handled");
    const noted = doneTask("Noted");
    const last = doneTask("Last");
    const eligible = eligibleTasks(
      r.tasks.list(),
      repoId,
      new Set([handled.id]),
      new Set([noted.id]),
    );
    expect(eligible.map((t) => t.id)).toEqual([first.id, archived.id, last.id]);
  });
});

describe("memoryBackfillPrompt", () => {
  it("carries the task, its plan and summary, and only the user's answers", () => {
    const task = doneTask("Add login", { freeText: "Use OAuth", plan: "The plan" });
    const asked = r.grillQuestions.create({ taskId: task.id, question: "Which provider?" });
    r.grillQuestions.answer(asked.id, "GitHub only", "user");
    const byAgent = r.grillQuestions.create({ taskId: task.id, question: "Where?" });
    r.grillQuestions.answer(byAgent.id, "In src/auth", "agent");
    const text = memoryBackfillPrompt({
      task,
      questions: r.grillQuestions.listByTask(task.id),
      memories: [],
      defaultBranch: "develop",
    });
    expect(text).toContain("# Task\n\nAdd login");
    expect(text).toContain("## Details\n\nUse OAuth");
    expect(text).toContain("## Plan\n\nThe plan");
    expect(text).toContain("## Summary\n\nSummary of Add login");
    expect(text).toContain("Which provider?\n  Answer (user): GitHub only");
    expect(text).not.toContain("Where?");
    expect(text).toContain("the code may have moved on");
    expect(text).not.toContain("merged into `develop`");
    expect(text).toContain('{ "memories": [');
  });

  it("tells a pull request task's run the checkout may lack its changes", () => {
    const task = prTask("PR", 7);
    const text = memoryBackfillPrompt({
      task,
      questions: [],
      memories: [],
      defaultBranch: "develop",
    });
    expect(text).toContain("kept only if this pull request is merged into `develop`");
    expect(text).toContain("may not be merged yet");
    expect(text).not.toContain("the code may have moved on");
  });
});

describe("createMemoryBackfill", () => {
  it("runs each eligible task once, oldest first, read-only in the repo's checkout", async () => {
    const first = doneTask("First");
    const second = doneTask("Second");
    const { backfill, claude, run } = setup({
      script: (call) => (call === 0 ? reply("Use pnpm") : reply()),
    });
    expect(backfill.status(repoId)).toMatchObject({ running: false, pending: 2 });
    const status = await run();
    expect(status).toEqual({
      running: false,
      pending: 0,
      done: 2,
      saved: 1,
      skipped: 0,
      failed: 0,
    });
    expect(claude.calls.map((c) => c.options.prompt.split("\n")[2])).toEqual(["First", "Second"]);
    expect(claude.calls[0]!.options).toMatchObject({ cwd: "/code/app" });
    expect(claude.calls[0]!.options.permissions.profile).toBe("read-only");
    expect(claude.calls[0]!.options.jsonSchema).toMatchObject({ required: ["memories"] });
    expect(notes(first.id)).toEqual([{ text: "Use pnpm", awaitingMerge: false }]);
    // A reply with no notes still marks the task.
    expect(processed()).toEqual([first.id, second.id].sort());

    expect((await run()).done).toBe(0);
    expect(claude.calls).toHaveLength(2);
  });

  it("marks tasks with notes, held or active, without a run and never refills them", async () => {
    const active = doneTask("Active");
    r.memories.replaceForTask(active.id, repoId, [{ kind: "context", text: "Kept" }]);
    const held = prTask("Held", 3);
    r.memories.replaceForTask(held.id, repoId, [{ kind: "context", text: "Waiting" }], {
      awaitingMerge: true,
    });
    const { backfill, claude, prMergeState, run } = setup();
    expect(backfill.status(repoId).pending).toBe(0);
    await run();
    expect(claude.calls).toHaveLength(0);
    expect(prMergeState).not.toHaveBeenCalled();
    expect(processed()).toEqual([active.id, held.id].sort());
    expect(notes(held.id)).toEqual([{ text: "Waiting", awaitingMerge: true }]);

    for (const m of r.memories.listByRepo(repoId)) r.memories.delete(m.id);
    expect(backfill.status(repoId).pending).toBe(0);
    await run();
    expect(claude.calls).toHaveLength(0);
  });

  it("holds an open or merged pull request's notes and asks for a release check", async () => {
    const openPr = prTask("Open", 1);
    const mergedPr = prTask("Merged", 2);
    const onHeld = vi.fn();
    const { run } = setup({
      onHeld,
      script: (call) => reply(`Note ${call}`),
      prMergeState: async (task) =>
        task.id === mergedPr.id ? { state: "closed", merged: true, baseRef: "develop" } : open,
    });
    expect(await run()).toMatchObject({ done: 2, saved: 2, skipped: 0 });
    expect(notes(openPr.id)).toEqual([{ text: "Note 0", awaitingMerge: true }]);
    expect(notes(mergedPr.id)).toEqual([{ text: "Note 1", awaitingMerge: true }]);
    expect(onHeld).toHaveBeenCalledOnce();
  });

  it("marks a pull request closed unmerged or merged elsewhere without a run", async () => {
    const rejected = prTask("Rejected", 1);
    const elsewhere = prTask("Elsewhere", 2);
    const onHeld = vi.fn();
    const { claude, run } = setup({
      onHeld,
      prMergeState: async (task) =>
        task.id === rejected.id
          ? { state: "closed", merged: false, baseRef: "develop" }
          : { state: "closed", merged: true, baseRef: "release" },
    });
    expect(await run()).toMatchObject({ pending: 0, done: 2, skipped: 2, saved: 0 });
    expect(claude.calls).toHaveLength(0);
    expect(processed()).toEqual([rejected.id, elsewhere.id].sort());
    expect(onHeld).not.toHaveBeenCalled();
  });

  it("leaves a pull request it cannot look up for the next pass", async () => {
    const task = prTask("PR", 1);
    const { claude, log, run } = setup({
      prMergeState: async () => {
        throw new Error("No GitHub token");
      },
    });
    expect(await run()).toMatchObject({ pending: 1, done: 1, failed: 1 });
    expect(claude.calls).toHaveLength(0);
    expect(processed()).toEqual([]);
    expect(log).toHaveBeenCalledWith(`Memory backfill of task ${task.id} skipped: No GitHub token`);
  });

  it("runs the summarizer on the task's CLI for it, with that CLI's model", async () => {
    const summarizerId = agents.resolveRoles().summarizer!;
    r.agents.update(summarizerId, { models: { copilot: "gpt-test" } });
    doneTask("Copilot", { agentClis: { [summarizerId]: "copilot" } });
    const claude = createFakeAdapter("claude", () => reply());
    const copilot = createFakeAdapter("copilot", () => reply());
    const { run } = setup({ adapters: { claude, copilot } });
    await run();
    expect(claude.calls).toHaveLength(0);
    expect(copilot.calls).toHaveLength(1);
    expect(copilot.calls[0]!.options.model).toBe("gpt-test");
    expect(copilot.calls[0]!.options.systemPrompt).toBeTruthy();
  });

  it("falls back to the repo's default CLI, and fails without a usable adapter", async () => {
    const summarizerId = agents.resolveRoles().summarizer!;
    doneTask("Copilot", { agentClis: { [summarizerId]: "copilot" } });
    const { claude, run } = setup();
    await run();
    expect(claude.calls).toHaveLength(1);

    r.repos.update(repoId, { defaultCli: "opencode" });
    const task = doneTask("Opencode", { cli: "opencode" });
    const second = setup();
    expect(await second.run()).toMatchObject({ done: 1, failed: 1, pending: 1 });
    expect(second.claude.calls).toHaveLength(0);
    expect(processed()).not.toContain(task.id);
    expect(second.log).toHaveBeenCalledWith("No adapter for the opencode CLI");
  });

  it("leaves a failed run unmarked and moves on", async () => {
    const failed = doneTask("Fails");
    const next = doneTask("Works");
    const { log, run } = setup({
      script: (call) => (call === 0 ? { fail: "boom" } : reply("Kept")),
    });
    expect(await run()).toMatchObject({ done: 2, failed: 1, saved: 1, pending: 1 });
    expect(processed()).toEqual([next.id]);
    expect(log).toHaveBeenCalledWith(`Memory backfill of task ${failed.id} failed: boom`);
  });

  it("reports the repo changed after each saved task, not a skipped or failed one", async () => {
    doneTask("Fails");
    prTask("Rejected", 1);
    const works = doneTask("Works");
    const onChanged = vi.fn();
    const { run } = setup({
      onChanged,
      script: (call) => (call === 0 ? { fail: "boom" } : reply("Kept")),
      prMergeState: async () => ({ state: "closed", merged: false, baseRef: "develop" }),
    });
    expect(await run()).toMatchObject({ done: 3, saved: 1, skipped: 1, failed: 1 });
    expect(notes(works.id)).toEqual([{ text: "Kept", awaitingMerge: false }]);
    expect(onChanged.mock.calls).toEqual([[repoId]]);
  });

  it("stops the pass at a usage limit", async () => {
    doneTask("Limited");
    doneTask("Never reached");
    const { claude, log, run } = setup({ script: () => ({ rateLimit: {} }) });
    expect(await run()).toMatchObject({ done: 0, failed: 0, pending: 2 });
    expect(claude.calls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("Memory backfill stopped: the claude CLI hit its usage limit");
  });

  it("refuses a second start while a pass runs, and stop() aborts it", async () => {
    const task = doneTask("Hangs");
    const { backfill, claude, finish } = setup({ script: () => ({ hang: true }) });
    backfill.start(repoId);
    expect(() => backfill.start(repoId)).toThrow(MemoryBackfillBusyError);
    await vi.waitFor(() => expect(claude.calls).toHaveLength(1));
    expect(backfill.status(repoId)).toMatchObject({ running: true, pending: 1 });
    backfill.stop();
    await finish();
    expect(claude.calls[0]!.options.signal?.aborted).toBe(true);
    expect(processed()).not.toContain(task.id);
  });

  it("aborts a pull request lookup in flight", async () => {
    prTask("PR", 1);
    const { backfill, claude, finish, prMergeState } = setup({
      prMergeState: (_task, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
    backfill.start(repoId);
    await vi.waitFor(() => expect(prMergeState).toHaveBeenCalled());
    backfill.stop();
    await finish();
    expect(claude.calls).toHaveLength(0);
    expect(backfill.status(repoId)).toMatchObject({ failed: 0, pending: 1 });
  });

  it("logs a failing onHeld or store and still ends the pass", async () => {
    prTask("PR", 1);
    const first = setup({
      script: () => reply("Held note"),
      onHeld: () => {
        throw new Error("release broke");
      },
    });
    await first.run();
    expect(first.log).toHaveBeenCalledWith(
      "Memory release after the backfill failed: release broke",
    );

    doneTask("Other");
    const broken = {
      ...r,
      memories: {
        ...r.memories,
        replaceForTask: () => {
          throw new Error("disk full");
        },
      },
    } as unknown as Repositories;
    const second = setup({ repositories: broken, script: () => reply("x") });
    await second.run();
    expect(second.log).toHaveBeenCalledWith("Memory backfill failed: disk full");
    expect(second.backfill.status(repoId).running).toBe(false);
  });

  it("rejects an unknown repo", () => {
    const { backfill } = setup();
    expect(() => backfill.status("nope")).toThrow(/nope/);
    expect(() => backfill.start("nope")).toThrow(/nope/);
  });
});
